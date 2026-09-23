# dsh-config

DeepSeek Harness (DSH) 本机架构与配置快照。

## 内容

- AGENTS.md — 两条常驻铁律（优先检索轮子 + 元认知反射）
- settings.yaml — 模型/LLM provider 配置（apiKeyEnv 引用，无明文密钥）
- profile-web/ — web profile 配置（cordis.patch.yml / cordis.yml / package.json / pnpm-workspace.yaml）
- dsh-skill-studio-patched/ — dsh-skill-studio 提取器修复版（多帧 zstd 解压 + token 预算 + JSON 解析）

## 安全

不含任何密钥：.credentials.yaml、xtractor.json、secrets.cmd 均已排除。

## License

MIT License. See [LICENSE](LICENSE).
