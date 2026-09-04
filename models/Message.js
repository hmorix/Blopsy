import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, index: true },
    role: { type: String, enum: ['USER', 'AI'], required: true },
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now, index: true }
});

export const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);
