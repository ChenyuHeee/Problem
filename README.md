# 题库练习（GitHub Pages）

本仓库包含一个纯静态网页练习系统，支持：逐题作答、提交后展示正确答案、答题进度记录、错题回顾。

## 本地运行

```bash
/Users/hechenyu/projects/Problem/.venv/bin/python -m http.server 5173 --directory web
```

浏览器打开：

- http://localhost:5173/

## 更新题库（从 PDF 重新提取）

```bash
/Users/hechenyu/projects/Problem/.venv/bin/python scripts/extract_questions.py \
  --pdf "bank/求是学院分党校入党积极分子结业考试学习资料（2025.12）.pdf" \
  --out web/questions.json
```

## 部署到 GitHub Pages

仓库已包含 GitHub Actions 工作流，会在推送到 `main` 后自动把 `web/` 部署到 Pages。

在 GitHub 网页端开启：

1. Settings → Pages
2. Build and deployment → Source 选择 **GitHub Actions**
3. 等待 Actions 运行完成后访问 Pages 链接
