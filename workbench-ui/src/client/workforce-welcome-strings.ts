import { createI18nProxy } from './i18n.ts'

const zh = {
  team: [
    { label: '拆解一个任务', prompt: '帮我拆解这个任务，给出执行步骤和分工：' },
    { label: '调研一个主题', prompt: '帮我调研这个主题，整理关键信息与参考来源：' },
    { label: '一起完善想法', prompt: '我有一个想法，请帮我补充思路并制定可执行方案：' },
  ],
  analyst: [
    { label: '分析一个问题', prompt: '请帮我分析这个问题，梳理原因、依据和可行方案：' },
    { label: '调研一个主题', prompt: '请调研这个主题，整理关键信息与参考来源：' },
    { label: '整理已有资料', prompt: '请整理这些资料，提炼重点并列出需要进一步确认的地方：' },
  ],
  writer: [
    { label: '起草一份内容', prompt: '请帮我起草一份内容，读者、主题和用途是：' },
    { label: '改写与润色', prompt: '请帮我改写这段内容，让表达更清楚自然：' },
    { label: '构思新的创意', prompt: '请围绕这个主题提出几个不同方向的创意：' },
  ],
  generic: [
    { label: '开始一个任务', prompt: '请帮我完成这个任务，目标和要求是：' },
    { label: '整理已有材料', prompt: '请帮我整理这些材料，提炼要点和下一步行动：' },
    { label: '一起探索想法', prompt: '我想和你一起探索这个想法：' },
  ],
  channelDescription: (name: string) => `${name}会接下你的目标，安排团队执行，并把结果汇总给你。`,
  dmDescription: (title: string) => `${title ? `我负责${title}。` : ''}直接告诉我你想完成的事，我们从这里开始。`,
  aria: (title: string) => `${title}欢迎页`,
  channelTitle: '今天想完成什么？',
  dmTitle: (name: string) => `你好，我是${name}`,
  suggestionsTitle: '试试从这里开始',
}

const en = {
  team: [
    { label: 'Break down a task', prompt: 'Help me break down this task into steps and responsibilities: ' },
    { label: 'Research a topic', prompt: 'Research this topic and organize key findings and sources: ' },
    { label: 'Develop an idea', prompt: 'Help me develop this idea into an actionable plan: ' },
  ],
  analyst: [
    { label: 'Analyze a problem', prompt: 'Analyze this problem, including causes, evidence, and possible solutions: ' },
    { label: 'Research a topic', prompt: 'Research this topic and organize key findings and sources: ' },
    { label: 'Organize materials', prompt: 'Organize these materials and identify key points and open questions: ' },
  ],
  writer: [
    { label: 'Draft content', prompt: 'Help me draft content for this audience, topic, and purpose: ' },
    { label: 'Rewrite and polish', prompt: 'Rewrite this text to make it clearer and more natural: ' },
    { label: 'Explore creative ideas', prompt: 'Suggest several creative directions for this topic: ' },
  ],
  generic: [
    { label: 'Start a task', prompt: 'Help me complete this task. The goal and requirements are: ' },
    { label: 'Organize materials', prompt: 'Organize these materials into key points and next steps: ' },
    { label: 'Explore an idea', prompt: 'I would like to explore this idea with you: ' },
  ],
  channelDescription: (name: string) => `${name} will take your goal, coordinate the team, and summarize the outcome.`,
  dmDescription: (title: string) => `${title ? `I focus on ${title}. ` : ''}Tell me what you want to accomplish and we can start here.`,
  aria: (title: string) => `${title} welcome page`,
  channelTitle: 'What would you like to accomplish today?',
  dmTitle: (name: string) => `Hi, I’m ${name}`,
  suggestionsTitle: 'Try starting here',
}

export const WELCOME = createI18nProxy(zh, en)
