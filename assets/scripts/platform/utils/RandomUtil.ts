export class RandomUtil{
    static getRandomElements(arr:any[], count = 1) {
    // 复制原数组，避免修改原数组
    const shuffled = [...arr];
    
    // Fisher-Yates洗牌算法
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    // 返回前count个元素
    return shuffled.slice(0, count);
}
}