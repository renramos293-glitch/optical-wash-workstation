# 光流与频域洗白工作站（本地复刻版）

## 启动

```bash
npm install
npm start
```

默认地址：`http://localhost:5000`

## 公网部署（Render）

这个项目已经补好了 `Render` 部署配置文件：`render.yaml`

最简单的发布步骤：

1. 把当前项目上传到 GitHub
2. 打开 [Render 控制台](https://dashboard.render.com/)
3. 选择 `New` → `Blueprint`
4. 连接你的 GitHub 仓库
5. Render 会自动识别仓库根目录的 `render.yaml`
6. 点击创建并等待部署完成
7. 部署成功后，你会得到一个公网网址，例如：`https://你的项目名.onrender.com`

### 很重要：文件持久化

- Render 默认文件系统是临时的
- 这意味着：服务重启或重新部署后，上传记录和输出文件可能会丢失
- 如果你想长期保存上传文件，需要在 Render 里额外挂载磁盘，并把环境变量 `DATA_DIR` 设到挂载目录下，例如：`/var/data/optical-wash`

## 已复刻能力

- 拖拽 / 点击上传图片或视频
- 异步任务列表轮询
- 成品下载
- 一键清理上传与输出文件
- 本地任务持久化到 `data/tasks.json`

## 当前处理逻辑

- 图片：使用 `sharp` 生成带柔化背景与提亮效果的成品图
- 视频：保留原视频内容并走异步转存流程，便于后续替换成 `ffmpeg` 或你的真实算法

## Render 环境变量

- `PORT`：Render 自动注入
- `HOST`：默认 `0.0.0.0`
- `DATA_DIR`：可选，自定义任务数据与上传输出目录
