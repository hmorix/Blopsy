import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, default: 'global_config' },
    systemPrompt: { type: String, required: true },
    allowedNumbers: { type: [String], default: [] },
    updatedAt: { type: Date, default: Date.now }
});

export const Settings = mongoose.models.Settings || mongoose.model('Settings', settingsSchema);
