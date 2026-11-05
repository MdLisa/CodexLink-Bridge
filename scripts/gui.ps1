$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Net.Http,System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CodexLinkWindow {
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
}
'@
$script:address=$env:CODEXLINK_CONTROL_ADDRESS
$script:token=$env:CODEXLINK_CONTROL_TOKEN
if(-not $script:address -or -not $script:token){throw 'Please launch the CodexLink control panel.'}
$hasher=[Security.Cryptography.SHA256]::Create()
try{$mutexName='Local\CodexLinkControl-'+[BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($env:CODEXLINK_CONTROL_DATA).ToUpperInvariant()))).Replace('-','')}finally{$hasher.Dispose()}
$script:mutex=New-Object Threading.Mutex($false,$mutexName)
try{$hasMutex=$script:mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$hasMutex=$true}
if(-not $hasMutex){[Windows.MessageBox]::Show('控制台已经打开，请切换到现有窗口。','CodexLink')|Out-Null;exit 0}
$script:client=New-Object Net.Http.HttpClient
$script:client.Timeout=[TimeSpan]::FromSeconds(145)
$script:client.DefaultRequestHeaders.Add('x-codexlink-control',$script:token)
$env:CODEXLINK_CONTROL_TOKEN=$null
$script:requests=New-Object Collections.ArrayList
$script:busy=$false
$script:statePending=$false
$script:state=$null
$script:selected=$null
$script:updating=$false
$script:devicesSignature=''
$script:settingsLoaded=$false
$script:requestsOpen=$true

[xml]$xaml=@'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="CodexLink 控制台" Width="1180" Height="830" MinWidth="1000" MinHeight="700" WindowStartupLocation="CenterScreen" Background="#F3F5F8" FontFamily="Microsoft YaHei UI" FontSize="13" Foreground="#172B3A">
 <Window.Resources>
  <Style TargetType="Button"><Setter Property="Padding" Value="16,9"/><Setter Property="Margin" Value="0,0,8,8"/><Setter Property="Background" Value="White"/><Setter Property="Foreground" Value="#172B3A"/><Setter Property="BorderBrush" Value="#D7E0E7"/><Setter Property="Cursor" Value="Hand"/><Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button"><Border x:Name="Body" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1" CornerRadius="7" Padding="{TemplateBinding Padding}"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border><ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Body" Property="Opacity" Value="0.8"/></Trigger><Trigger Property="IsEnabled" Value="False"><Setter TargetName="Body" Property="Opacity" Value="0.45"/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
  <Style x:Key="Primary" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}"><Setter Property="Background" Value="#0E8074"/><Setter Property="Foreground" Value="White"/><Setter Property="BorderBrush" Value="#0E8074"/></Style>
  <Style x:Key="Nav" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}"><Setter Property="HorizontalContentAlignment" Value="Left"/><Setter Property="Background" Value="#203649"/><Setter Property="Foreground" Value="#E0EAF1"/><Setter Property="BorderBrush" Value="#203649"/><Setter Property="Margin" Value="0,0,0,10"/><Setter Property="Padding" Value="18,14"/></Style>
  <Style TargetType="TextBox"><Setter Property="Padding" Value="10,8"/><Setter Property="Margin" Value="0,5,0,14"/><Setter Property="BorderBrush" Value="#D2DCE4"/><Setter Property="Background" Value="#FCFDFE"/><Setter Property="VerticalContentAlignment" Value="Center"/></Style>
  <Style TargetType="PasswordBox"><Setter Property="Padding" Value="10,8"/><Setter Property="Margin" Value="0,5,0,14"/><Setter Property="BorderBrush" Value="#D2DCE4"/></Style>
  <Style TargetType="ComboBox"><Setter Property="Padding" Value="8"/><Setter Property="Margin" Value="0,5,0,14"/><Setter Property="MinHeight" Value="35"/></Style>
  <Style TargetType="CheckBox"><Setter Property="Margin" Value="0,7,0,12"/></Style>
  <Style x:Key="Card" TargetType="Border"><Setter Property="Background" Value="White"/><Setter Property="CornerRadius" Value="12"/><Setter Property="Padding" Value="24"/><Setter Property="BorderBrush" Value="#E1E7EC"/><Setter Property="BorderThickness" Value="1"/><Setter Property="Margin" Value="0,0,0,18"/></Style>
  <Style x:Key="Muted" TargetType="TextBlock"><Setter Property="Foreground" Value="#647887"/><Setter Property="TextWrapping" Value="Wrap"/><Setter Property="LineHeight" Value="22"/></Style>
  <Style x:Key="Heading" TargetType="TextBlock"><Setter Property="FontSize" Value="18"/><Setter Property="FontWeight" Value="SemiBold"/><Setter Property="Margin" Value="0,0,0,16"/></Style>
 </Window.Resources>
 <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="210"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
  <Border Background="#152B3D" Padding="20,30"><DockPanel LastChildFill="True">
   <StackPanel DockPanel.Dock="Top"><TextBlock Text="CodexLink" FontSize="26" FontWeight="Bold" Foreground="White"/><TextBlock Text="电脑连接 · 管理控制台" Foreground="#9FB4C4" Margin="0,8,0,32"/>
    <Button x:Name="NavHome" Content="概览" Style="{StaticResource Nav}"/><Button x:Name="NavDevices" Content="手机设备" Style="{StaticResource Nav}"/><Button x:Name="NavSettings" Content="连接与设置" Style="{StaticResource Nav}"/><Button x:Name="NavLogs" Content="日志与诊断" Style="{StaticResource Nav}"/>
   </StackPanel>
   <StackPanel DockPanel.Dock="Bottom" VerticalAlignment="Bottom"><TextBlock Text="v0.10.1" Foreground="#A6BCCB" Margin="0,0,0,10"/><TextBlock Text="关闭窗口后，已启动的连接继续运行。" Foreground="#91A9BA" TextWrapping="Wrap" LineHeight="21"/></StackPanel>
  </DockPanel></Border>
  <Grid Grid.Column="1" Margin="30,26,30,16"><Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
   <DockPanel Margin="0,0,0,22"><Button x:Name="Refresh" DockPanel.Dock="Right" Content="刷新状态" Margin="12,0,0,0"/><StackPanel><TextBlock x:Name="PageTitle" Text="连接概览" FontSize="27" FontWeight="SemiBold"/><TextBlock x:Name="PageSubtitle" Text="连接手机，管理你的电脑后台。" Style="{StaticResource Muted}" Margin="0,8,0,0"/></StackPanel></DockPanel>
   <Grid Grid.Row="1">
    <ScrollViewer x:Name="HomePage" VerticalScrollBarVisibility="Auto"><StackPanel Margin="0,0,8,0">
     <UniformGrid Columns="3" Margin="0,0,0,18">
      <Border Style="{StaticResource Card}" Margin="0,0,12,0"><StackPanel><TextBlock Text="电脑后台" Style="{StaticResource Muted}"/><TextBlock x:Name="BackendStatus" Text="检查中…" FontSize="22" FontWeight="SemiBold" Margin="0,12,0,8"/><TextBlock x:Name="BackendDetail" Text="读取本机运行状态" Style="{StaticResource Muted}"/></StackPanel></Border>
      <Border Style="{StaticResource Card}" Margin="0,0,12,0"><StackPanel><TextBlock Text="Codex" Style="{StaticResource Muted}"/><TextBlock x:Name="CodexStatus" Text="检查中…" FontSize="22" FontWeight="SemiBold" Margin="0,12,0,8"/><TextBlock Text="使用本机已有登录" Style="{StaticResource Muted}"/></StackPanel></Border>
      <Border Style="{StaticResource Card}" Margin="0"><StackPanel><TextBlock Text="外网入口" Style="{StaticResource Muted}"/><TextBlock x:Name="TunnelStatus" Text="检查中…" FontSize="22" FontWeight="SemiBold" Margin="0,12,0,8"/><TextBlock x:Name="TunnelDetail" Text="固定或临时地址" Style="{StaticResource Muted}"/></StackPanel></Border>
     </UniformGrid>
     <Border Style="{StaticResource Card}"><StackPanel><TextBlock Text="手机连接" Style="{StaticResource Heading}"/><TextBlock Text="连接地址" Style="{StaticResource Muted}"/><TextBox x:Name="ConnectionAddress" IsReadOnly="True" Text="尚未启动" FontSize="17" Background="#F2F8F7"/><WrapPanel x:Name="HomeActions"><Button x:Name="Start" Content="启动手机连接" Style="{StaticResource Primary}"/><Button x:Name="Restart" Content="重启连接"/><Button x:Name="Stop" Content="停止连接" Foreground="#AC3E3E"/><Button x:Name="CopyAddress" Content="复制地址"/><Button x:Name="CheckPublic" Content="检测外网"/></WrapPanel><TextBlock x:Name="ConnectionHint" Text="启动时依次连接电脑后台与外网，手机使用上方地址登录。" Style="{StaticResource Muted}" Margin="0,8,0,0"/></StackPanel></Border>
     <Border Style="{StaticResource Card}"><StackPanel><TextBlock Text="设备与工作目录" Style="{StaticResource Heading}"/><TextBlock x:Name="DeviceSummary" Text="正在读取设备…" Margin="0,0,0,12"/><TextBlock Text="默认项目目录" Style="{StaticResource Muted}"/><TextBlock x:Name="WorkspaceSummary" TextWrapping="Wrap" Margin="0,5,0,14"/><TextBlock Text="附件目录" Style="{StaticResource Muted}"/><TextBlock x:Name="AttachmentSummary" TextWrapping="Wrap" Margin="0,5,0,16"/><Button x:Name="GoDevices" Content="管理手机设备 →" HorizontalAlignment="Left"/></StackPanel></Border>
    </StackPanel></ScrollViewer>
    <Grid x:Name="DevicesPage" Visibility="Collapsed"><Grid.ColumnDefinitions><ColumnDefinition Width="0.95*"/><ColumnDefinition Width="1.3*"/></Grid.ColumnDefinitions>
     <Border Style="{StaticResource Card}" Margin="0,0,16,0" Padding="16"><DockPanel><StackPanel DockPanel.Dock="Top"><TextBlock Text="设备列表" Style="{StaticResource Heading}"/><TextBox x:Name="DeviceSearch" ToolTip="搜索备注、设备名称或核对码"/><TextBlock Text="按备注、名称或核对码搜索" Style="{StaticResource Muted}" Margin="0,0,0,14"/></StackPanel><TextBlock x:Name="DeviceEmpty" DockPanel.Dock="Bottom" Text="暂无设备。手机登录后会出现在这里。" Style="{StaticResource Muted}" Margin="0,12,0,0"/><ListBox x:Name="DeviceList" BorderThickness="0" Background="Transparent" ScrollViewer.HorizontalScrollBarVisibility="Disabled"><ListBox.ItemTemplate><DataTemplate><StackPanel Margin="6,10" MaxWidth="280"><TextBlock Text="{Binding displayName}" FontSize="15" FontWeight="SemiBold" TextWrapping="Wrap"/><TextBlock Text="{Binding subtitle}" Foreground="#647887" Margin="0,5,0,0" TextWrapping="Wrap"/></StackPanel></DataTemplate></ListBox.ItemTemplate></ListBox></DockPanel></Border>
     <ScrollViewer Grid.Column="1" VerticalScrollBarVisibility="Auto"><Border Style="{StaticResource Card}" Margin="0,0,8,0" Padding="22"><StackPanel>
      <TextBlock x:Name="DeviceTitle" Text="选择一台手机" Style="{StaticResource Heading}"/><TextBlock x:Name="DeviceIdentity" Text="在左侧选择手机，查看授权和配置。" Style="{StaticResource Muted}" Margin="0,0,0,16"/>
      <StackPanel x:Name="DeviceEditor" IsEnabled="False">
       <TextBlock Text="设备备注（仅电脑可见）"/><TextBox x:Name="DeviceNote" MaxLength="80"/><Button x:Name="SaveNote" Content="保存备注" HorizontalAlignment="Left"/>
       <Border Background="#F1F7F6" CornerRadius="7" Padding="14" Margin="0,8,0,16"><StackPanel><TextBlock Text="核对码" Foreground="#48695E"/><TextBox x:Name="DeviceCode" IsReadOnly="True" Margin="0,6,0,0" FontFamily="Consolas" FontSize="17"/><TextBlock Text="批准前，请与手机屏幕上的核对码逐项核对。" Style="{StaticResource Muted}" Margin="0,6,0,0"/></StackPanel></Border>
       <WrapPanel><Button x:Name="ApproveDevice" Content="核对一致，批准手机" Style="{StaticResource Primary}"/><Button x:Name="RevokeDevice" Content="撤销授权"/><Button x:Name="DeleteDevice" Content="删除设备" Foreground="#AC3E3E"/></WrapPanel>
       <Separator Margin="0,12,0,18"/><TextBlock Text="项目访问范围" FontWeight="SemiBold"/>
       <ComboBox x:Name="DeviceScope"><ComboBoxItem Content="指定目录" Tag="directories"/><ComboBoxItem Content="所有目录" Tag="all"/></ComboBox>
       <TextBox x:Name="DeviceRoots" AcceptsReturn="True" MinHeight="74" MaxHeight="140" VerticalScrollBarVisibility="Auto" ToolTip="每行一个完整目录路径"/>
       <WrapPanel><Button x:Name="AddDeviceRoot" Content="＋ 选择目录"/><Button x:Name="SaveDeviceScope" Content="保存项目范围"/></WrapPanel>
       <TextBlock Text="操作方式" FontWeight="SemiBold" Margin="0,16,0,0"/>
       <ComboBox x:Name="DeviceReviewer"><ComboBoxItem Content="手动审批" Tag="user"/><ComboBoxItem Content="帮我批准（官方自动审查）" Tag="auto_review"/><ComboBoxItem Content="仅聊天（允许联网）" Tag="chat_only"/></ComboBox><Button x:Name="SaveDeviceReviewer" Content="保存操作方式" HorizontalAlignment="Left"/>
       <TextBlock Text="单独授权" FontWeight="SemiBold" Margin="0,18,0,0"/>
       <CheckBox x:Name="TakeoverPermission" Content="允许退出桌面 Codex 并接管"/><Button x:Name="SaveTakeover" Content="保存接管权限" HorizontalAlignment="Left"/>
       <CheckBox x:Name="DownloadPermission" Content="允许下载生成文档（仅操作模式，单文件 20 MB）"/><Button x:Name="SaveDownloads" Content="保存文档下载权限" HorizontalAlignment="Left"/>
       <CheckBox x:Name="ViewerPermission" Content="允许只读查看其他手机的仅聊天会话"/><Button x:Name="SaveViewer" Content="保存只读查看权限" HorizontalAlignment="Left"/>
       <TextBlock Text="删除设备会清理登记、登录凭据、备注和授权。聊天及附件保留；该手机再次登录时需重新批准。" Style="{StaticResource Muted}" Margin="0,18,0,0"/>
      </StackPanel>
     </StackPanel></Border></ScrollViewer>
    </Grid>
    <ScrollViewer x:Name="SettingsPage" Visibility="Collapsed" VerticalScrollBarVisibility="Auto"><StackPanel x:Name="SettingsEditor" Margin="0,0,8,0">
     <Border Style="{StaticResource Card}"><StackPanel><TextBlock Text="目录与连接" Style="{StaticResource Heading}"/><TextBlock Text="默认项目目录"/><DockPanel><Button x:Name="ChooseWorkspace" Content="选择目录" DockPanel.Dock="Right" Margin="10,5,0,14"/><TextBox x:Name="Workspace"/></DockPanel><TextBlock Text="电脑附件目录"/><DockPanel><Button x:Name="ChooseAttachments" Content="选择目录" DockPanel.Dock="Right" Margin="10,5,0,14"/><TextBox x:Name="Attachments"/></DockPanel><TextBlock Text="后台端口"/><TextBox x:Name="Port" Width="140" HorizontalAlignment="Left"/><TextBlock Text="新手机默认审批（不修改已配置手机）"/><ComboBox x:Name="DefaultReviewer"><ComboBoxItem Content="手动审批" Tag="user"/><ComboBoxItem Content="帮我批准（官方自动审查）" Tag="auto_review"/><ComboBoxItem Content="仅聊天（允许联网）" Tag="chat_only"/></ComboBox><Button x:Name="SaveSettings" Content="保存设置" Style="{StaticResource Primary}" HorizontalAlignment="Left"/><TextBlock Text="目录和端口修改后重启连接生效；手机已配置的项目范围独立保留。" Style="{StaticResource Muted}"/></StackPanel></Border>
     <Border Style="{StaticResource Card}"><StackPanel><TextBlock Text="开机自动启动" Style="{StaticResource Heading}"/><TextBlock x:Name="StartupStatus" Text="检查中…" Margin="0,0,0,14"/><Button x:Name="ToggleStartup" Content="切换自启" HorizontalAlignment="Left"/><TextBlock Text="登录 Windows 后隐藏启动后台与外网，无需打开此窗口。" Style="{StaticResource Muted}"/></StackPanel></Border>
     <Border Style="{StaticResource Card}"><StackPanel><TextBlock Text="固定外网" Style="{StaticResource Heading}"/><TextBlock x:Name="TunnelConfigStatus" Style="{StaticResource Muted}" Margin="0,0,0,14"/><TextBlock Text="HTTPS 域名"/><TextBox x:Name="Hostname"/><TextBlock Text="Cloudflare 完整连接命令或令牌"/><PasswordBox x:Name="TunnelCommand"/><WrapPanel><Button x:Name="SaveTunnel" Content="保存固定外网" Style="{StaticResource Primary}"/><Button x:Name="QuickTunnel" Content="改用临时地址"/></WrapPanel><TextBlock Text="凭据使用当前 Windows 用户加密保存。保存后重启连接生效；域名路由需在 Cloudflare 中指向本机后台。" Style="{StaticResource Muted}"/></StackPanel></Border>
     <Border Style="{StaticResource Card}"><StackPanel><TextBlock Text="账号与密码" Style="{StaticResource Heading}"/><TextBlock Text="账号"/><TextBox x:Name="Username" MaxLength="64"/><TextBlock Text="新密码（至少 8 个字符）"/><PasswordBox x:Name="Password"/><TextBlock Text="再输入一次"/><PasswordBox x:Name="Repeated"/><Button x:Name="SaveAccount" Content="设置账号密码" HorizontalAlignment="Left"/><TextBlock Text="修改后旧手机登录会失效，需要重新登录和批准；聊天记录保留。" Style="{StaticResource Muted}"/></StackPanel></Border>
    </StackPanel></ScrollViewer>
    <Grid x:Name="LogsPage" Visibility="Collapsed"><Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/></Grid.RowDefinitions><StackPanel><WrapPanel><Button x:Name="ReloadLogs" Content="读取最新日志" Style="{StaticResource Primary}"/><Button x:Name="CopyLogs" Content="复制诊断日志"/></WrapPanel><TextBlock Text="最近的后台与外网日志；已过滤常见密码、令牌和管理凭据。" Style="{StaticResource Muted}" Margin="0,0,0,12"/></StackPanel><TextBox x:Name="LogText" Grid.Row="1" IsReadOnly="True" AcceptsReturn="True" TextWrapping="Wrap" VerticalContentAlignment="Top" VerticalScrollBarVisibility="Auto" FontFamily="Consolas, Microsoft YaHei UI" Background="#172D3E" Foreground="#DCE8F0" Padding="18" BorderThickness="0"/></Grid>
   </Grid>
   <Border Grid.Row="2" Background="#E7F1EF" CornerRadius="8" Padding="14,11" Margin="0,16,0,0"><DockPanel><ProgressBar x:Name="Progress" DockPanel.Dock="Right" Width="90" Height="4" IsIndeterminate="True" Visibility="Collapsed" Margin="12,0,0,0" Foreground="#0E8074"/><TextBlock x:Name="Notice" Text="正在读取本机状态…" TextWrapping="Wrap" Foreground="#35645B"/></DockPanel></Border>
  </Grid>
 </Grid>
</Window>
'@
$script:window=[Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))
$script:ui=@{}
# Read names without requiring an XML namespace prefix manager.
foreach($node in $xaml.SelectNodes('//*')){foreach($attribute in $node.Attributes){if($attribute.LocalName -eq 'Name'){$script:ui[$attribute.Value]=$script:window.FindName($attribute.Value)}}}

function Show-Notice([string]$text,[bool]$error=$false){$ui.Notice.Text=$text;$ui.Notice.Foreground=if($error){'#A13D3D'}else{'#35645B'}}
function Confirm-Action([string]$text){return [Windows.MessageBox]::Show($window,$text,'确认操作',[Windows.MessageBoxButton]::YesNo,[Windows.MessageBoxImage]::Warning) -eq [Windows.MessageBoxResult]::Yes}
function Set-Busy([bool]$value){$script:busy=$value;$ui.Progress.Visibility=if($value){'Visible'}else{'Collapsed'};$ui.HomeActions.IsEnabled=-not $value;$ui.SettingsEditor.IsEnabled=-not $value;$ui.DeviceEditor.IsEnabled=(-not $value -and $null -ne $script:selected)}
function Select-Tag($combo,[string]$tag){foreach($item in $combo.Items){if($item.Tag -eq $tag){$combo.SelectedItem=$item;return}};$combo.SelectedIndex=0}
function Choose-Folder([string]$current){$dialog=New-Object Windows.Forms.FolderBrowserDialog;$dialog.Description='选择电脑上的文件夹';if([IO.Directory]::Exists($current)){$dialog.SelectedPath=$current};try{if($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK){return $dialog.SelectedPath};return $null}finally{$dialog.Dispose()}}
function Request-Control([string]$method,[string]$route,$data,[string]$kind,$callback){
 if(-not $script:requestsOpen){return}
 $content=$null
 try{
  if($method -eq 'GET'){$task=$client.GetAsync($script:address+$route)}else{$json=ConvertTo-Json -InputObject $data -Depth 12 -Compress;$content=New-Object Net.Http.StringContent($json,[Text.Encoding]::UTF8,'application/json');$task=$client.PostAsync($script:address+$route,$content)}
  [void]$script:requests.Add(@{task=$task;kind=$kind;callback=$callback;content=$content;actionName=$data.action})
 }catch{if($kind -eq 'state'){$script:statePending=$false};if($kind -eq 'action'){Set-Busy $false};Show-Notice '无法连接本机管理程序，请重新打开控制台。' $true}
}
function Refresh-State {if($script:statePending){return};$script:statePending=$true;Request-Control 'GET' '/state' $null 'state' {param($result) Apply-State $result}}
function Run-Action([string]$action,$data=@{},[string]$message='正在保存…'){
 if($script:busy){return};Set-Busy $true;Show-Notice $message
 Request-Control 'POST' '/action' @{action=$action;data=$data} 'action' {param($result,$request) Show-Notice $result.message;if($request.actionName.StartsWith('device.')){$script:devicesSignature=''};if($request.actionName -in @('settings','account','tunnel','quickTunnel')){$script:settingsLoaded=$false};Refresh-State}
}
function Device-Data {if(-not $script:selected){throw '请先选择手机。'};return @{fingerprint=$script:selected.fingerprint;generation=$script:selected.generation}}
function Run-Device([string]$action,$extra=@{}){$data=Device-Data;foreach($key in $extra.Keys){$data[$key]=$extra[$key]};Run-Action ('device.'+$action) $data}
function Show-Page([string]$name){
 foreach($page in @('Home','Devices','Settings','Logs')){$ui[$page+'Page'].Visibility=if($page -eq $name){'Visible'}else{'Collapsed'};$ui['Nav'+$page].Background=if($page -eq $name){'#0E8074'}else{'#203649'}}
 $titles=@{Home=@('连接概览','连接手机，管理你的电脑后台。');Devices=@('手机设备','备注、批准与授权，都在这里管理。');Settings=@('连接与设置','设置目录、外网入口和启动方式。');Logs=@('日志与诊断','查看最近的运行记录，定位连接问题。')}
 $ui.PageTitle.Text=$titles[$name][0];$ui.PageSubtitle.Text=$titles[$name][1]
 if($name -eq 'Logs'){Read-Logs}
}
function Update-DeviceList {
 $search=$ui.DeviceSearch.Text.Trim();$items=@($script:state.devices|Where-Object{-not $search -or ($_.note+' '+$_.name+' '+$_.code).IndexOf($search,[StringComparison]::OrdinalIgnoreCase) -ge 0})
 $selectedFingerprint=if($script:selected){$script:selected.fingerprint}else{''};$script:updating=$true
 $ui.DeviceList.Items.Clear()
 foreach($device in $items){$label=if($device.note){$device.note}else{$device.name};$status=@{pending='等待批准';approved='已批准';revoked='已撤销'}[$device.status];$device|Add-Member -NotePropertyName displayName -NotePropertyValue $label -Force;$device|Add-Member -NotePropertyName subtitle -NotePropertyValue ($status+' · '+$device.name+"`n"+$device.code) -Force;[void]$ui.DeviceList.Items.Add($device);if($device.fingerprint -eq $selectedFingerprint){$ui.DeviceList.SelectedItem=$device}}
 $script:updating=$false;$ui.DeviceEmpty.Visibility=if($items.Count -eq 0){'Visible'}else{'Collapsed'}
 if($selectedFingerprint -and -not @($script:state.devices|Where-Object{$_.fingerprint -eq $selectedFingerprint}).Count){$script:selected=$null;$ui.DeviceEditor.IsEnabled=$false;$ui.DeviceTitle.Text='选择一台手机';$ui.DeviceIdentity.Text='设备已从列表移除。';$ui.DeviceNote.Clear();$ui.DeviceCode.Clear();$ui.DeviceRoots.Clear();$ui.TakeoverPermission.IsChecked=$false;$ui.ViewerPermission.IsChecked=$false;$ui.DownloadPermission.IsChecked=$false}
}
function Load-Device($device){
 if(-not $device){return};$script:selected=$device;$ui.DeviceTitle.Text=if($device.note){$device.note}else{$device.name};$ui.DeviceIdentity.Text=$device.name+' · '+@{pending='等待批准';approved='已批准';revoked='已撤销'}[$device.status]+"`n运行中的任务："+$device.activeTasks
 $ui.DeviceNote.Text=$device.note;$ui.DeviceCode.Text=$device.code;Select-Tag $ui.DeviceScope $device.scope.mode;$ui.DeviceRoots.Text=$device.scope.roots -join "`r`n";Select-Tag $ui.DeviceReviewer $device.reviewer;$ui.TakeoverPermission.IsChecked=$device.takeover;$ui.ViewerPermission.IsChecked=$device.viewer;$ui.DownloadPermission.IsChecked=$device.downloads
 $ui.ApproveDevice.IsEnabled=$device.status -ne 'approved';$ui.RevokeDevice.IsEnabled=$device.status -eq 'approved';$ui.SaveViewer.IsEnabled=$device.status -eq 'approved';$ui.DeviceEditor.IsEnabled=-not $script:busy
}
function Apply-State($value){
 $script:state=$value;$ui.BackendStatus.Text=if($value.backend){'运行中'}else{'未启动'};$ui.BackendStatus.Foreground=if($value.backend){'#0E8074'}else{'#647887'};$ui.BackendDetail.Text=if($value.backend){'后台 v'+$value.runtime.version}else{'可先配置，再启动'}
 $ui.CodexStatus.Text=if($value.online){'已连接'}elseif($value.backend){'正在连接'}else{'未连接'};$ui.CodexStatus.Foreground=if($value.online){'#0E8074'}else{'#647887'};$ui.TunnelStatus.Text=if($value.tunnel){'已连接'}else{'未启动'};$ui.TunnelStatus.Foreground=if($value.tunnel){'#0E8074'}else{'#647887'}
 $ui.TunnelDetail.Text=if($value.settings.fixedConfigured){'使用固定域名'}else{'使用临时地址'};$ui.ConnectionAddress.Text=if($value.address){$value.address}else{'尚未配置，启动后生成'};$ui.Start.IsEnabled=-not ($value.backend -and $value.tunnel);$ui.Stop.IsEnabled=$value.backend -or $value.tunnel;$ui.Restart.IsEnabled=$value.backend -or $value.tunnel
 $pending=@($value.devices|Where-Object{$_.status -eq 'pending'}).Count;$approved=@($value.devices|Where-Object{$_.status -eq 'approved'}).Count;$ui.DeviceSummary.Text=('{0} 台已批准 · {1} 台待批准 · {2} 台设备登记' -f $approved,$pending,@($value.devices).Count)
 $ui.WorkspaceSummary.Text=$value.settings.workspace;$ui.AttachmentSummary.Text=$value.settings.attachments
 $ui.StartupStatus.Text=if($null -eq $value.settings.startup){'状态未知：'+$value.settings.startupError}elseif($value.settings.startup){'已开启：登录 Windows 后自动连接'}else{'未开启'};$ui.ToggleStartup.Content=if($value.settings.startup){'关闭开机自动启动'}else{'开启开机自动启动'};$ui.ToggleStartup.IsEnabled=$null -ne $value.settings.startup
 $ui.TunnelConfigStatus.Text=if($value.settings.fixedConfigured){'当前固定域名：'+$value.settings.hostname}else{'当前使用临时地址，每次创建可能变化。'}
 if(-not $script:settingsLoaded){$ui.Workspace.Text=$value.settings.workspace;$ui.Attachments.Text=$value.settings.attachments;$ui.Port.Text=[string]$value.settings.port;$ui.Username.Text=$value.settings.username;$ui.Hostname.Text=$value.settings.hostname;Select-Tag $ui.DefaultReviewer $value.settings.defaultReviewer;$script:settingsLoaded=$true}
 $signature=ConvertTo-Json -InputObject $value.devices -Depth 8 -Compress
 if($signature -ne $script:devicesSignature){$forceDetails=$script:devicesSignature -eq '';$script:devicesSignature=$signature;Update-DeviceList;if($forceDetails -and $script:selected){$fresh=@($value.devices|Where-Object{$_.fingerprint -eq $script:selected.fingerprint});if($fresh.Count){Load-Device $fresh[0]}}}
 if($value.deviceError){Show-Notice $value.deviceError $true}elseif($ui.Notice.Text -eq '正在读取本机状态…'){Show-Notice '状态已更新。可以在此启动连接或管理手机。'}
 if($value.backend -and $value.runtime.roots[0] -ne $value.settings.workspace){$ui.ConnectionHint.Text='默认项目目录已修改，当前运行目录为 '+$value.runtime.roots[0]+'；重启连接后应用新设置。'}else{$ui.ConnectionHint.Text='启动时依次连接电脑后台与外网；关闭此窗口不会停止连接。'}
}
function Read-Logs {Request-Control 'GET' '/logs' $null 'logs' {param($result) $ui.LogText.Text=(@($result.logs|ForEach-Object{'===== '+$_.name+' ====='+"`r`n"+$_.text}) -join "`r`n`r`n")}}

$ui.NavHome.Add_Click({Show-Page 'Home'});$ui.NavDevices.Add_Click({Show-Page 'Devices'});$ui.NavSettings.Add_Click({Show-Page 'Settings'});$ui.NavLogs.Add_Click({Show-Page 'Logs'});$ui.GoDevices.Add_Click({Show-Page 'Devices'})
$ui.Refresh.Add_Click({Refresh-State});$ui.Start.Add_Click({Run-Action 'start' @{} '正在启动后台并连接外网，请稍候…'})
$ui.Stop.Add_Click({if(Confirm-Action '停止连接会中断手机任务。确认停止？'){Run-Action 'stop' @{} '正在关闭外网并停止后台…'}})
$ui.Restart.Add_Click({if(Confirm-Action '重启连接会中断当前手机任务。确认重启并应用已保存的设置？'){Run-Action 'restart' @{} '正在重启后台和外网…'}})
$ui.CopyAddress.Add_Click({if($script:state.address){[Windows.Clipboard]::SetText($script:state.address);Show-Notice '手机连接地址已复制。'}})
$ui.CheckPublic.Add_Click({Run-Action 'checkPublic' @{} '正在校验外网连接…'})
$ui.DeviceSearch.Add_TextChanged({if($script:state){Update-DeviceList}})
$ui.DeviceList.Add_SelectionChanged({if(-not $script:updating){Load-Device $ui.DeviceList.SelectedItem}})
$ui.SaveNote.Add_Click({Run-Device 'note' @{note=$ui.DeviceNote.Text.Trim()}})
$ui.ApproveDevice.Add_Click({if(Confirm-Action ('请确认手机屏幕核对码为：'+$ui.DeviceCode.Text+"`n批准后，该手机可按配置访问后台。")){Run-Device 'approve' @{code=$ui.DeviceCode.Text}}})
$ui.RevokeDevice.Add_Click({if(Confirm-Action '撤销后该手机无法继续访问；保留设备登记，之后可重新批准。确认撤销？'){Run-Device 'revoke'}})
$ui.DeleteDevice.Add_Click({if(Confirm-Action '删除此设备的登记、登录凭据、备注及全部授权？排队任务会取消，聊天和附件保留。再次登录时需重新批准。'){Run-Device 'delete'}})
$ui.DeviceScope.Add_SelectionChanged({$ui.DeviceRoots.IsEnabled=$ui.DeviceScope.SelectedItem.Tag -eq 'directories';$ui.AddDeviceRoot.IsEnabled=$ui.DeviceScope.SelectedItem.Tag -eq 'directories'})
$ui.AddDeviceRoot.Add_Click({$folder=Choose-Folder '';if($folder){$ui.DeviceRoots.Text=($ui.DeviceRoots.Text.Trim()+"`r`n"+$folder).Trim()}})
$ui.SaveDeviceScope.Add_Click({$mode=$ui.DeviceScope.SelectedItem.Tag;$roots=@();if($mode -eq 'directories'){$roots=@($ui.DeviceRoots.Text -split '\r?\n'|ForEach-Object{$_.Trim()}|Where-Object{$_})};if($mode -ne 'all' -or (Confirm-Action '允许访问所有目录？这会扩大该手机的项目范围。')){Run-Device 'scope' @{scope=@{mode=$mode;roots=$roots}}}})
$ui.SaveDeviceReviewer.Add_Click({if(Confirm-Action '保存此手机的操作方式？切换仅聊天模式需等待运行中的任务结束，旧模式排队任务会取消。'){Run-Device 'reviewer' @{reviewer=$ui.DeviceReviewer.SelectedItem.Tag}}})
$ui.SaveTakeover.Add_Click({if(-not $ui.TakeoverPermission.IsChecked -or (Confirm-Action '允许该手机在确认后退出整个桌面 Codex 并接管？可能中断电脑上的其他任务。')){Run-Device 'takeover' @{enabled=[bool]$ui.TakeoverPermission.IsChecked}}})
$ui.SaveDownloads.Add_Click({Run-Device 'downloads' @{enabled=[bool]$ui.DownloadPermission.IsChecked}})
$ui.SaveViewer.Add_Click({if(-not $ui.ViewerPermission.IsChecked -or (Confirm-Action '允许该手机只读查看其他已批准手机的仅聊天记录和图片？')){Run-Device 'viewer' @{enabled=[bool]$ui.ViewerPermission.IsChecked}}})
$ui.ChooseWorkspace.Add_Click({$folder=Choose-Folder $ui.Workspace.Text;if($folder){$ui.Workspace.Text=$folder}})
$ui.ChooseAttachments.Add_Click({$folder=Choose-Folder $ui.Attachments.Text;if($folder){$ui.Attachments.Text=$folder}})
$ui.SaveSettings.Add_Click({Run-Action 'settings' @{workspace=$ui.Workspace.Text.Trim();attachments=$ui.Attachments.Text.Trim();port=$ui.Port.Text.Trim();defaultReviewer=$ui.DefaultReviewer.SelectedItem.Tag}})
$ui.ToggleStartup.Add_Click({if($script:state){Run-Action 'startup' @{enabled=-not [bool]$script:state.settings.startup}}})
$ui.SaveTunnel.Add_Click({$command=$ui.TunnelCommand.Password;$ui.TunnelCommand.Clear();Run-Action 'tunnel' @{hostname=$ui.Hostname.Text.Trim();command=$command}})
$ui.QuickTunnel.Add_Click({if(Confirm-Action '清除当前固定外网配置，改用临时地址？保存后需重启连接，手机地址可能变化。'){Run-Action 'quickTunnel'}})
$ui.SaveAccount.Add_Click({if(Confirm-Action '修改账号密码后，已有手机必须重新登录和批准。确认修改？'){$password=$ui.Password.Password;$repeated=$ui.Repeated.Password;$ui.Password.Clear();$ui.Repeated.Clear();Run-Action 'account' @{username=$ui.Username.Text.Trim();password=$password;repeated=$repeated}}})
$ui.ReloadLogs.Add_Click({Read-Logs});$ui.CopyLogs.Add_Click({if($ui.LogText.Text){[Windows.Clipboard]::SetText($ui.LogText.Text);Show-Notice '已复制过滤后的诊断日志。'}})

$script:requestTimer=New-Object Windows.Threading.DispatcherTimer
$requestTimer.Interval=[TimeSpan]::FromMilliseconds(100)
$requestTimer.Add_Tick({
 foreach($request in @($script:requests.ToArray())){if(-not $request.task.IsCompleted){continue};[void]$script:requests.Remove($request)
  try{if($request.task.IsCanceled -or $request.task.IsFaulted){throw 'request failed'};$response=$request.task.GetAwaiter().GetResult();$text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult();$payload=ConvertFrom-Json $text;if(-not $response.IsSuccessStatusCode){throw $payload.error};& $request.callback $payload $request
  }catch{$message=$_.Exception.Message;if($request.task.IsFaulted -or $request.task.IsCanceled){$message='本机管理程序暂时无响应，请刷新状态。'};Show-Notice $message $true
  }finally{if($response){$response.Dispose();$response=$null};if($request.content){$request.content.Dispose()};if($request.kind -eq 'state'){$script:statePending=$false};if($request.kind -eq 'action'){Set-Busy $false}}
 }
})
$script:stateTimer=New-Object Windows.Threading.DispatcherTimer
$stateTimer.Interval=[TimeSpan]::FromSeconds(4);$stateTimer.Add_Tick({Refresh-State})
$window.Add_Loaded({
 # A console-free launcher can pass SW_HIDE to the first window. Explicitly show our own HWND.
 [void][CodexLinkWindow]::ShowWindow((New-Object Windows.Interop.WindowInteropHelper $window).Handle,5)
 [void]$window.Activate()
 Show-Page 'Home';Refresh-State;$requestTimer.Start();$stateTimer.Start()
})
$window.Add_Closing({param($sender,$eventArgs) if($script:busy){$eventArgs.Cancel=$true;Show-Notice '操作仍在进行，请等待结果后关闭窗口。'}})
$window.Add_Closed({$script:requestsOpen=$false;$requestTimer.Stop();$stateTimer.Stop();$client.Dispose()})
try{[void]$window.ShowDialog()}finally{$script:mutex.ReleaseMutex();$script:mutex.Dispose()}
