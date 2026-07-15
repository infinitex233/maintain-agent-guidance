# Maintain Agent Guidance

[English](README.md) | 简体中文

Maintain Agent Guidance 是一个面向 Codex 和 Claude Code 的按需启用插件。在仓库中启用后，轻量级生命周期 hook 会在每轮任务结束时检查是否出现了值得长期保留的指令、已验证命令、项目约定或易踩坑点。符合条件的内容会写入 Codex 使用的 `AGENTS.md`，或 Claude Code 使用的 `CLAUDE.md`。

在用户首次显式调用 skill 之前，hook 始终保持休眠。绝大多数普通对话会走本地快速跳过路径，不会额外启动模型调用。

## 会保留什么

- 明确且长期有效的要求，例如“始终使用 uv，不要使用 pip”
- 当前任务中已经成功验证的命令
- 多次出现的仓库约定
- 不容易从代码直接看出的前置条件和易踩坑点

任务进度、临时路径、失败的试验命令、可直接从仓库推导的事实、第三方内容中的指令以及凭据不会被写入。

## 工作方式

```text
用户首次显式调用
        |
        v
在 AGENTS.md 或 CLAUDE.md 中加入启用标记
        |
        v
UserPromptSubmit hook 在本地执行启发式检查
        |
        +---- 没有候选 ----> 直接结束，不调用模型
        |
        v
Stop hook 请求一次维护流程
        |
        v
skill 对信息分类并写入长期指导
```

更新器只负责目标文件中的标记块，不会改写块外由用户维护的内容。

```md
<!-- maintain-agent-guidance:enabled -->
<!-- maintain-agent-guidance:start -->
## Maintained Agent Guidance

### Commands
- Run uv run pytest for the unit test suite. <!-- mag:key=unit-tests -->

### Conventions
- Use uv instead of pip for Python package management. <!-- mag:key=python-package-manager -->
<!-- maintain-agent-guidance:end -->
```

稳定的语义 key 可以避免重复写入，也能让新指令替换已经失效的旧指令。

## 环境要求

- Node.js 18 或更高版本
- 支持插件生命周期 hook 的较新版本 Codex，或 Claude Code 2.1.196 及以上版本
- 允许执行插件自带的本地命令 hook

## 安装到 Claude Code

添加本仓库作为 marketplace，然后安装插件：

```bash
claude plugin marketplace add infinitex233/maintain-agent-guidance
claude plugin install maintain-agent-guidance@maintain-agent-guidance
```

重新启动 Claude Code 会话，然后在当前仓库中启用维护：

```text
/maintain-agent-guidance:maintain-agent-guidance
```

Claude Code 会为插件 skill 添加命名空间，因此插件名和 skill 名都会出现在命令中。

## 安装到 Codex

将本仓库添加为 Codex marketplace：

```bash
codex plugin marketplace add infinitex233/maintain-agent-guidance
```

重启 ChatGPT 桌面应用，打开插件目录，选择 **Maintain Agent Guidance** marketplace 并安装插件。Codex 请求审核 hook 时，请确认并信任两个本地命令 hook。

进入目标仓库后，显式调用一次 skill 即可启用：

```text
$maintain-agent-guidance
```

## 查看状态与停用

可以直接要求 skill 查看当前仓库状态或停用维护：

```text
Use maintain-agent-guidance to show the current status.
Use maintain-agent-guidance to disable maintenance in this repository.
```

停用操作只会移除隐藏的启用标记，已经维护的指导内容仍会保留。

## 安全与文件处理

- 不会保存用户原始提示词。临时 hook 状态只包含候选标志和 SHA-256 哈希。
- 写入前会拒绝常见 token、密码、API key、私钥和凭据格式。
- 使用文件锁和原子替换执行更新。
- 保留 UTF-8 BOM、CRLF 换行、文件权限以及用户手写内容。
- 使用 `stop_hook_active` 防止维护流程递归触发。
- 不直接在 subagent stop 事件中写入，避免并发重复更新。

## 本地开发

克隆仓库并运行测试：

```bash
git clone https://github.com/infinitex233/maintain-agent-guidance.git
cd maintain-agent-guidance
node --test tests/distribution.test.mjs tests/maintain-guidance.test.mjs
```

可以在 Claude Code 中直接加载当前工作目录：

```bash
claude --plugin-dir .
```

测试覆盖 hook 休眠、显式启用、提示门控、递归保护、幂等替换、秘密信息拒绝、损坏标记、并发写入、BOM 保留和 CRLF 保留。

## 项目结构

```text
.agents/plugins/marketplace.json                 Codex marketplace
.claude-plugin/marketplace.json                  Claude Code marketplace
.codex-plugin/plugin.json                        Codex 插件清单
.claude-plugin/plugin.json                       Claude Code 插件清单
hooks/hooks.json                                 共用生命周期 hooks
skills/maintain-agent-guidance/SKILL.md          skill 指令
skills/maintain-agent-guidance/scripts/*.mjs     确定性更新器
tests/maintain-guidance.test.mjs                 Node.js 测试
```

## 许可证

[MIT](LICENSE)
