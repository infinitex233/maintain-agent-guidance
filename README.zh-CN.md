# Maintain Agent Guidance

[English](README.md) | 简体中文

Maintain Agent Guidance 是一个面向 Codex 和 Claude Code 的按需启用插件。在仓库中启用后，轻量级生命周期 hook 会在每轮任务结束时检查是否出现了值得长期保留的指令、已验证命令、项目约定或易踩坑点。符合条件的内容会写入 Codex 使用的 `AGENTS.md`，或 Claude Code 使用的 `CLAUDE.md`。

在用户首次显式调用 skill 之前，每个 hook 进程只检查启用标记，随后立即退出，不写入状态，也不请求额外模型回合。启用后，未命中候选的回合仍会走本地快速跳过路径。

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

## 轻量化说明

Codex 会[渐进加载](https://learn.chatgpt.com/docs/build-skills.md) skill。普通 skill 列表只包含名称、描述和文件路径，只有在选中该 skill 时才读取完整的 `SKILL.md`。以 `o200k_base` tokenizer 估算，本插件在列表中约占 65 tokens，完整 skill 约为 357 tokens。

安装并启用插件后，每轮会启动两个本地 Node.js hook 进程。仓库级维护仍需单独启用：没有启用标记时，两个进程只做一次文件检查便返回。启用后，普通回合只运行本地启发式判断；对当前 hook 输入，不会写入状态。本机 Windows、Node.js 22 基准中，两个无操作 hook 的总耗时中位数约为 0.18 到 0.20 秒。实际时间会随宿主、硬件和文件系统变化。

命中候选时会请求一个额外模型回合。skill 与 hook 的静态指令合计约增加 400 tokens，实际成本还取决于已有对话和模型输出。`must`、`avoid`、`root cause is` 等宽泛措辞可能触发检查，即使最终没有写入内容。已维护条目也会成为常规 `AGENTS.md` 或 `CLAUDE.md` 上下文，因此 skill 只保留简短、长期有效的信息。

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

- 不会保存用户原始提示词。临时 hook 状态只包含生命周期标识与计数器、候选标志和 SHA-256 哈希。
- 写入前会拒绝常见 GitHub、GitLab、npm、AWS、Google、Slack、Bearer、JWT、密码、私钥和凭据格式。
- 使用失败关闭文件锁和原子替换执行更新；陈旧锁会报告可操作的路径，而不会冒险并发写入。
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

测试覆盖 hook 休眠、显式启用、真实 Claude/Codex hook 输入、宿主识别、提示门控、递归保护、幂等替换、shell 安全文本传输、秘密信息拒绝、损坏标记、并发写入、陈旧锁诊断、BOM 保留和 CRLF 保留。

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
