# macOS Apple Silicon 支持

当前开发分支提供 macOS Apple Silicon（arm64）第一阶段支持，目标是让 M1、M2、M3、M4 等机型能够使用桌宠、动画、Codex / Claude Code 会话展示、审批和一键 Hook 配置。

## 当前支持

- macOS arm64 桌宠窗口和菜单栏图标
- Codex CLI 与 Claude Code 会话状态
- Agent 工具审批
- 一键安装并自检 Codex / Claude hooks
- GIF 动画、图片导入和桌宠外观设置
- CPU 与内存显示
- 开机启动
- macOS arm64 DMG 构建
- 按平台检查和下载 GitHub Release 更新

## 暂未支持

- macOS 全局键盘活动动画
- macOS GPU 使用率
- macOS 实时上下行网速
- Intel Mac

这些选项在 macOS 菜单中会被禁用，不影响会话和桌宠核心功能。

## 开发运行

需要 Apple Silicon Mac、Node.js 20 或更新版本：

```bash
npm ci
npm test
npm start
```

## 一键配置 hooks

启动 Agent Pet，在菜单栏图标中选择“一键配置本机 AI（macOS）”。安装器会：

1. 将 bridge 安装到 `~/.agent-pet`。
2. 使用 Agent Pet 自身的 Electron runtime 运行 hook，不要求用户单独安装 Node.js。
3. 合并 `~/.codex/hooks.json` 和 `~/.claude/settings.json`。
4. 分别执行 Codex 和 Claude bridge 自检。

配置完成后需要完全退出并重新打开 Codex / Claude Code。Codex 用户还需要输入 `/hooks`，审阅并信任 Agent Pet hooks。

状态和审批文件位于：

```text
~/Library/Application Support/AgentPet/states
~/Library/Application Support/AgentPet/approvals
```

## 构建 arm64 DMG

```bash
npm run dist:mac
```

输出文件：

```text
dist/AgentPet-<version>-mac-arm64.dmg
```

仓库内的 `build-macos-arm64.yml` 也可以在 macOS GitHub Actions runner 上运行测试并生成未签名的 DMG artifact。

## 正式发布

公开分发前需要配置 Apple Developer ID Application 证书和公证凭据。没有签名与公证的测试包可能被 Gatekeeper 拦截，只适合内部验证。
