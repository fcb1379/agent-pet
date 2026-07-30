# Agent Pet

Agent Pet 是一个 Windows 桌面宠物，用动画和托盘状态显示以下 Agent 的活动：

- Windows Codex CLI
- WSL Codex CLI
- Windows Claude Code
- WSL Claude Code

支持状态：空闲、执行中、等待输入/授权、完成、错误。完成动画显示 15 秒后自动回到空闲；错误状态显示 60 秒。

## 桌面功能

右键任务栏托盘中的 Agent Pet 图标可使用：

- 桌宠 / 红绿灯两种显示模式
- 75%、100%、125%、150% 四档大小
- 50%、75%、90%、100% 四档透明度
- 鼠标穿透模式；支持临时恢复拖动、记住任意桌面位置和恢复右下角
- 键盘打字动画开关
- 自定义桌宠主图、悬停动画帧、动画风格和播放速度
- 鼠标移入桌宠时随机播放内置动作或用户帧动画
- 单击桌宠后在点击位置敲木鱼；点击越快反馈越强，每日次数保存在本机，停止点击后显示“今日功德”；拖动不会误触
- CPU、GPU、内存、上下行网速资源条；支持总开关和单项开关
- 点击右下角会话数，查看每个会话的 Agent、来源、状态、最近进度、目录和更新时间；待审批会话可在卡片内直接允许或拒绝
- 一键配置 Windows 和默认 WSL 中的 Codex / Claude Code hooks
- 开机启动、显示/隐藏；已结束会话可逐个关闭或一键清理，运行中或待输入会话可经二次确认强制移除本地记录（不会终止 Agent）

检测到键盘活动时，宠物会显示键盘、双手交替敲击和按键粒子动画。监听器只在任意键按下时上报一个布尔活动信号，不输出、存储或传输具体按键。资源数据每 2 秒在本机采样一次，不上传云端。

快捷键：

| 操作 | 快捷键 |
|---|---|
| 允许当前 Agent 授权请求 | `Ctrl+Shift+Enter` |
| 拒绝当前 Agent 授权请求 | `Ctrl+Shift+Backspace` |
| 开关鼠标穿透 | `Ctrl+Shift+Alt+P` |
| 穿透时临时调整位置（20 秒） | `Ctrl+Shift+Alt+M` |
| 打开/关闭会话详情 | `Ctrl+Shift+Alt+S` |

出现授权请求时，即使开启了鼠标穿透，桌宠也会暂时恢复点击并显示“允许/拒绝”按钮。桌宠不会自动批准；150 秒内没有选择时，授权会回退给原终端流程。

普通文本输入与工具审批不同：当前 hooks 能安全返回允许/拒绝，但不能代替用户向任意 Codex / Claude Code 提问输入文本。此类会话会在详情卡片中提示回到原会话继续，避免输入被误送到错误任务。

> 点击允许前仍应核对工具名称和操作摘要，尤其是删除文件、安装软件、推送代码等操作。

## 开发运行

需要 Node.js 20 或更新版本：

```powershell
npm install
npm start
```

## 自定义外观与动画

右键托盘图标，打开“外观与动画”：

- “更换桌宠主图”支持 PNG、JPG、WebP 和 GIF，单张不超过 25 MB。
- “导入 GIF 动画”会自动提取动画帧，并保留逐帧播放时长。
- “导入悬停动画帧”可多选最多 48 张图片，按文件名自然顺序播放，建议使用 `frame-01.png`、`frame-02.png` 的命名方式。
- 动画风格提供经典、活泼、轻柔和静止四种模式。
- 悬停帧速度可选快速、标准和慢速。
- “鼠标悬停随机动画”可随时关闭；开启时，每次移入宠物都会随机播放内置动作或自定义帧动画。

导入的图片会复制到 Agent Pet 的本地用户数据目录，不依赖原文件位置，也不会上传网络。
## 一键配置本机 AI

启动桌宠，右键托盘图标，选择“一键配置本机 AI（Windows + 默认 WSL）”。完成后：

1. 重启正在运行的 Codex CLI 和 Claude Code。
2. 在 Codex 中输入 `/hooks`。
3. 审阅并信任 Agent Pet hooks。

安装器会合并已有配置并首次创建 `.agent-pet.bak` 备份，不会替换无关 hooks。若使用多个 WSL 发行版，需要在其余发行版中按下面的手动方式分别安装。

## 手动安装 Agent hooks

### Windows

在 Windows PowerShell 中：

```powershell
git clone https://github.com/fcb1379/agent-pet.git
cd agent-pet
npm install
npm run install-hooks
```

### WSL

在每一个需要接入的 WSL 发行版内分别执行：

```bash
cd /mnt/c/path/to/agent-pet
npm run install-hooks
```

安装后重启 Codex 和 Claude Code。Codex 首次加载新 hooks 时，输入 `/hooks` 并信任 Agent Pet hooks。

## 验证动画

程序运行时执行：

```powershell
npm run simulate -- running codex
npm run simulate -- needs_input claude
npm run simulate -- completed codex
npm run simulate -- error claude
npm run simulate -- idle codex
```

## 卸载 hooks

在 Windows 和对应 WSL 中分别执行：

```bash
npm run uninstall-hooks
```

## 本地通信与安全

每个会话在 Windows 下写入：

```text
%LOCALAPPDATA%\AgentPet\states\<session-id>.json
```

待授权请求通过同级的 `approvals` 目录交换短期 JSON 文件。WSL bridge 使用 `cmd.exe` 查询 Windows 的 `%LOCALAPPDATA%`，因此与 Windows Agent 共用同一目录；不开放网络端口，也不需要云端服务。

状态优先级为：

```text
等待输入 > 错误 > 完成（15 秒）> 执行中 > 空闲
```

## 发布

```powershell
npm run test
npm run dist
```

发布产物位于 `dist\AgentPet-<version>-portable.exe`。

## 素材说明

`assets/mascot.png` 是为本项目生成的原创机器人水獭，不包含 QQ 宠物或其他品牌的原始角色素材。
