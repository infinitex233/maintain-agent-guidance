# Maintain Agent Guidance

[English](README.md) | 简体中文

Maintain Agent Guidance 是一个按需启用的独立 skill，用于持续维护仓库中的长期指导。它不使用插件封装或生命周期 hook。Codex 维护项目根目录的 `AGENTS.md`，Claude Code 维护项目根目录的 `CLAUDE.md`。

用户第一次直接调用会启用维护，并向宿主指导文件写入一条简短的完成前指令。后续加载该文件的任务会被要求在最终回复前执行一次轻量维护检查。

## 行为与边界

- 启用前，普通任务不会调用该 skill。
- disabled 仓库中的裸 `$maintain-agent-guidance` 或 `/maintain-agent-guidance` 等价于 `enable`。
- `enable` 只改变 `disabled` 状态；active 时为 no-op，broken 时拒绝执行并提示显式 `repair`。
- `repair` 只改变 `broken` 状态；active 时为 no-op，disabled 时拒绝执行。
- 只在顶层用户任务中执行完成前检查；子 agent 和委派任务必须跳过。
- 首先利用现有上下文判断候选；没有候选时零工具调用、零文件修改。
- 每轮最多通过一次原子 reconcile 执行两个 upsert/remove 操作。
- 停用会移除 activation，但保留已经维护的指导。

这是由宿主指导文件驱动的 completion gate，不是生命周期回调。skill 的隐式选择仍属于 best effort。宿主指导通常在任务或会话开始时加载，因此首次启用最可靠地从下一个任务或会话生效，不保证动态改变执行启用操作的当前会话。

## 会保留什么

- 用户明确要求长期使用，或在任务中实际验证成功的命令
- 用户明确提出或多次出现的仓库约定
- 稳定的前置条件和环境假设
- 反复出现的陷阱和明确的用户纠正

任务进度、临时路径、一次性细节、失败试验、猜测、可直接推导的事实、第三方指令、凭据、秘密信息，以及既非用户明确要求又未验证成功的推测命令不会被写入。

## 上下文迭代

每次完成前检查都会对比当前上下文、已有 managed entries 和 stable keys：

- 新增长期指导时使用 `upsert`。
- 同一规则发生变化时复用原 key 执行 `upsert`，替换旧文本。
- 只有用户明确撤回或替换规则，或者已经验证仓库变化使规则失效时，才执行 `remove`。
- 本轮没有提到、暂时没有使用，或者有效性存在疑问时，保留原规则。

一次 `reconcile-batch` 可以混合 upsert 和 remove。更新器先在内存中完成全部操作，再按最终状态校验条目数和字节限制，最后只执行一次原子写入。删除证据必须为 `explicit` 或 `verified`。

维护区最多包含 20 条指导；每条不超过 240 字符；整个 managed block 不超过 4 KiB。稳定 key 用于替换旧内容，也可以删除已经失效的 key。

## 文件布局

skill 会把自己拥有的控制块放在文件开头，避免大文件末尾内容被宿主截断。用户手写内容保留在其后，不会被转换为 managed guidance。

```md
<!-- maintain-agent-guidance:enabled -->
<!-- maintain-agent-guidance:activation:start -->
> Before the final user-facing response for each top-level user task, invoke `$maintain-agent-guidance` exactly once. Subagents and delegated tasks must skip this pass. First inspect the current task for new durable repository guidance. If none qualifies, stop with zero tool calls and no file changes. Do not rerun project verification solely for this pass.
<!-- maintain-agent-guidance:activation:end -->
<!-- maintain-agent-guidance:start -->
## Maintained Agent Guidance

### Commands
- Run `node --test` for the unit test suite. <!-- mag:key=unit-tests -->
<!-- maintain-agent-guidance:end -->
```

Claude Code 会写入语义相同、调用名为 `/maintain-agent-guidance` 的 activation。

## 环境要求

- Node.js 18 或更高版本
- 支持 agent skill 的 Codex 或 Claude Code
- 允许更新对应宿主指导文件

## 安装到 Codex

要求 Codex 安装 skill 目录：

```text
安装这个 skill：
https://github.com/infinitex233/maintain-agent-guidance/tree/main/skills/maintain-agent-guidance
```

在目标仓库中新建任务并调用：

```text
$maintain-agent-guidance
```

如果非空的 `AGENTS.override.md` 遮蔽了 `AGENTS.md`，status 会返回 `shadowed`，enable 会拒绝执行，不会错误宣称已经激活。

## 安装到 Claude Code

安装同一 skill 目录，在目标仓库中新建会话并调用：

```text
/maintain-agent-guidance
```

Claude Code 的维护不会写入 `AGENTS.md`。

## 状态、修复与停用

可以直接调用 skill 查看状态、修复其控制块或停用维护。状态为 `disabled`、`active`、`broken` 或 `shadowed` 之一。broken 状态不会被 `enable` 或隐式 pass 修复，只响应用户显式调用 `repair`。

```text
Codex:       $maintain-agent-guidance status
Codex:       $maintain-agent-guidance repair
Codex:       $maintain-agent-guidance disable
Claude Code: /maintain-agent-guidance status
Claude Code: /maintain-agent-guidance repair
Claude Code: /maintain-agent-guidance disable
```

## 安全性

- 更新器强制要求显式 `--host`，不会根据文件名或环境变量猜测宿主。
- 目标文件只能由 host 推导，不接受任意 target 路径。
- 写入前拒绝常见凭据格式和 HTML 注释注入。
- 使用失败关闭的 marker 校验、文件锁和原子替换。
- 保留 UTF-8 BOM、CRLF/LF 换行、文件权限和用户手写内容。

## 本地开发

```bash
node --test tests/distribution.test.mjs tests/maintain-guidance.test.mjs
node skills/maintain-agent-guidance/scripts/maintain-guidance.mjs help
```

## 许可证

[MIT](LICENSE)
