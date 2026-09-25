# dsh-config

DeepSeek Harness（DSH）本机架构与配置快照 —— 一键恢复「换机 / 迁移」所需的一切（除密钥）。

## 一键恢复

换新机后，clone 本仓库并运行：

    git clone https://github.com/hpsks416/dsh-config.git
    cd dsh-config
    pwsh install.ps1                 # 恢复配置 + 全部 skill（默认 GitHub 源）
    pwsh install.ps1 -Source gitee   # 国内直连更快

`install.ps1` 会：

1. 恢复全局指令 `AGENTS.md`、`settings.yaml`、web profile 配置
2. 恢复 `dsh-skill-studio` 修复版到 `~/.dsh/`，并重接 `package.json` 的 link
3. 批量 clone 21 个 skill 到 `~/.dsh/skills/`（`hatch-pet` 已退役，本地保留、未上云，不参与迁移）
4. 覆盖前先备份旧文件到 `~/.dsh/_backup_<时间戳>/`

恢复完成后：`cd ~/.dsh/profiles/web && pnpm install && 重启 DSH`。

## 内容

- `AGENTS.md` — 两条常驻铁律（优先检索轮子 + 元认知反射）
- `settings.yaml` — 模型/LLM provider 配置（`apiKeyEnv` 引用，无明文密钥）
- `profile-web/` — web profile 配置（cordis.patch.yml / cordis.yml / package.json / pnpm-workspace.yaml）
- `dsh-skill-studio-patched/` — dsh-skill-studio 提取器修复版（多帧 zstd 解压 + token 预算 + JSON 解析）
- `install.ps1` — 一键恢复脚本

## 安全

不含任何密钥：`.credentials.yaml`、`extractor.json`、`secrets.cmd` 均已排除。密钥需迁移后手动补齐（`install.ps1` 收尾会列清单）。

## License

MIT License. See [LICENSE](LICENSE).
