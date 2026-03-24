require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// 中间件
app.use(cors());
app.use(express.json());

// MongoDB 连接
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ai-prompts-hub';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// 提示词模型
const promptSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    aiTool: { type: String, required: true },
    content: { type: String, required: true },
    usage: String,
    tags: [String],
    author: { type: String, required: true },
    likes: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

const Prompt = mongoose.model('Prompt', promptSchema);

// 用户点赞记录模型
const userLikeSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    promptId: { type: String, required: true },
    clientIP: { type: String },
    createdAt: { type: Date, default: Date.now }
});

const UserLike = mongoose.model('UserLike', userLikeSchema);

// 用户收藏模型
const userFavoriteSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    promptId: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

const UserFavorite = mongoose.model('UserFavorite', userFavoriteSchema);

// API 路由

// 获取所有提示词
app.get('/api/prompts', async (req, res) => {
    try {
        const prompts = await Prompt.find().sort({ createdAt: -1 });
        res.json(prompts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 获取热门提示词
app.get('/api/prompts/hot', async (req, res) => {
    try {
        const prompts = await Prompt.find().sort({ likes: -1 });
        res.json(prompts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 获取单个提示词
app.get('/api/prompts/:id', async (req, res) => {
    try {
        const prompt = await Prompt.findOne({ id: req.params.id });
        if (!prompt) {
            return res.status(404).json({ error: 'Prompt not found' });
        }
        res.json(prompt);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 创建提示词
app.post('/api/prompts', async (req, res) => {
    try {
        console.log('Creating prompt:', req.body);
        const prompt = new Prompt(req.body);
        const savedPrompt = await prompt.save();
        console.log('Prompt saved:', savedPrompt);

        // 广播新提示词
        io.emit('prompt:created', savedPrompt);

        res.status(201).json(savedPrompt);
    } catch (err) {
        console.error('Error creating prompt:', err);
        if (err.code === 11000) {
            res.status(400).json({ error: '该提示词ID已存在' });
        } else {
            res.status(500).json({ error: err.message });
        }
    }
});

// 更新提示词
app.put('/api/prompts/:id', async (req, res) => {
    try {
        const prompt = await Prompt.findOneAndUpdate(
            { id: req.params.id },
            req.body,
            { new: true }
        );

        if (!prompt) {
            return res.status(404).json({ error: 'Prompt not found' });
        }

        // 广播更新
        io.emit('prompt:updated', prompt);

        res.json(prompt);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 删除提示词
app.delete('/api/prompts/:id', async (req, res) => {
    try {
        await Prompt.findOneAndDelete({ id: req.params.id });

        // 广播删除
        io.emit('prompt:deleted', req.params.id);

        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 点赞/取消点赞
app.post('/api/prompts/:id/like', async (req, res) => {
    try {
        const { userId, action } = req.body;
        const promptId = req.params.id;

        const prompt = await Prompt.findOne({ id: promptId });
        if (!prompt) {
            return res.status(404).json({ error: '提示词不存在' });
        }

        // 查找用户是否已经点赞过
        const existingLike = await UserLike.findOne({ userId, promptId });

        let likes;
        let liked;

        if (action === 'unlike') {
            // 取消点赞：删除点赞记录，减少点赞数
            if (existingLike) {
                await UserLike.deleteOne({ userId, promptId });
            }
            likes = Math.max(0, prompt.likes - 1);
            await Prompt.findOneAndUpdate(
                { id: promptId },
                { $set: { likes } }
            );
            liked = false;
            io.emit('like:removed', { promptId, userId, likes });
        } else {
            // 点赞：检查是否已点赞，如果未点赞则创建记录并增加点赞数
            if (!existingLike) {
                await UserLike.create({ userId, promptId, createdAt: new Date() });
                likes = prompt.likes + 1;
                await Prompt.findOneAndUpdate(
                    { id: promptId },
                    { $set: { likes } }
                );
            } else {
                // 已经点赞过，不重复增加
                likes = prompt.likes;
            }
            liked = true;
            io.emit('like:added', { promptId, userId, likes });
        }

        res.json({ liked, likes });
    } catch (err) {
        console.error('Like error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 获取用户点赞的提示词
app.get('/api/user/:userId/likes', async (req, res) => {
    try {
        const userLikes = await UserLike.find({ userId: req.params.userId });
        const promptIds = userLikes.map(like => like.promptId);
        res.json(promptIds);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 收藏/取消收藏
app.post('/api/prompts/:id/favorite', async (req, res) => {
    try {
        const { userId } = req.body;
        const promptId = req.params.id;

        const existingFavorite = await UserFavorite.findOne({ userId, promptId });

        if (existingFavorite) {
            // 取消收藏
            await UserFavorite.deleteOne({ userId, promptId });

            // 广播收藏变化
            io.emit('favorite:removed', { promptId, userId });

            res.json({ favorited: false });
        } else {
            // 收藏
            await UserFavorite.create({ userId, promptId });

            // 广播收藏变化
            io.emit('favorite:added', { promptId, userId });

            res.json({ favorited: true });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 获取用户收藏的提示词
app.get('/api/user/:userId/favorites', async (req, res) => {
    try {
        const userFavorites = await UserFavorite.find({ userId: req.params.userId });
        const promptIds = userFavorites.map(fav => fav.promptId);
        res.json(promptIds);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// WebSocket 连接处理
io.on('connection', (socket) => {
    console.log('✅ Client connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('❌ Client disconnected:', socket.id);
    });
});

// 健康检查
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 WebSocket server ready`);
});
