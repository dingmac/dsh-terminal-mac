# dsh-terminal-mac

DSH 插件（bundle）：一台隔离虚拟 Mac 的全套能力，一个插件搞定。

## 内容

一个 bundle 插入两条插件行：

1. **`@deepseek-ai/dsh-mcp-client`（serverName `terminal-mac`）** —— 连上 terminal-mac 自带的 stdio MCP 服务器，得到 `mcp__terminal-mac__*` 八个客户机内操作工具。
2. **本插件 `@local/dsh-terminal-mac`** —— 虚拟机生命周期工具（`terminal_mac_vm_*`）与内嵌 skill `virtual-mac`。

## 结构

```
index.js                    生命周期工具 + tools/pre-execute 审批监听 + skill 注册
cordis.patch.yml            两条插件行：MCP 连接 + 本插件配置
skills/virtual-mac/SKILL.md 内嵌 skill 正文
locale/{zh,en}.json         插件列表文案
docs/DETAIL.md              详情页
docs/preview.svg            详情页配图
icon.svg                    图标
```

## 关键实现点

- 工具定义是手写 JSON Schema 的普通对象，不用 `defineTool`：link 安装的插件解析不到 `@deepseek-ai/dsh-tools`（实测 `ERR_MODULE_NOT_FOUND`）。
- 生命周期命令用 `node:child_process.execFile` 调 launcher，带超时；`exec.signal` 取消时 `SIGTERM` 终止子进程。
- 审批按调用：`tools/pre-execute` 里仅当 `confirm === true`（或 `requireConfirm`）时返回 `ask`。
- skill 用 `ctx.inject(['skills'], ...)` 可选注入后 `ctx.skills.register()`，正文来自 `skills/virtual-mac/SKILL.md`；没有 skill 服务的 profile 里插件照常工作。
- 动作命令不回状态，执行后补一次 `status` 读真实状态。

## 安装

```bash
dsh plugin add <本目录绝对路径>
```

## 注意

- 改 `index.js` 或 skill 正文后需要重载插件（disable → enable）或重启 Harness。
- `terminal_mac_vm_stop` 会丢客户机里未保存的内容；`pause` 不释放内存。
