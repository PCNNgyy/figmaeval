export const project = {
  name: 'FigmaEval',
  title: 'FigmaEval: A Benchmark for Evaluating AI Agents in Professional UI Design',
  description: 'Evaluating AI agents on open-ended, multi-screen design tasks in native Figma, with expert-grounded rubrics and professional designer preferences.',
  github: 'https://github.com/PCNNgyy/figmaeval',
  arxiv: '',
  affiliations: ['Sun Yat-sen University', 'Southern University of Science and Technology', 'Xiamen University', 'SenseTime'],
  authors: [
    { name: 'Xinyue Huang', affiliations: [1], equalContribution: true },
    { name: 'Yongyong Gao', affiliations: [2], equalContribution: true },
    { name: 'Zhengyuan Pan', affiliations: [3, 4], equalContribution: true },
    { name: 'Xinya Liu', affiliations: [4], equalContribution: false },
    { name: 'Zheng Ma', affiliations: [4], equalContribution: false },
    { name: 'Lewei Lu', affiliations: [4], equalContribution: false },
    { name: 'Dahua Lin', affiliations: [4], equalContribution: false },
  ],
};

export const dimensions = [
  { name: 'User experience', short: 'Experience', maximum: 8, criteria: 4, detail: 'Can people discover key content and understand what they can do?' },
  { name: 'Information organization', short: 'Information', maximum: 15, criteria: 5, detail: 'Do grouping, reading hierarchy, and action priorities make sense?' },
  { name: 'Layout quality', short: 'Layout', maximum: 12, criteria: 4, detail: 'Are alignment, spacing, proportions, and whitespace well resolved?' },
  { name: 'Consistency', short: 'Consistency', maximum: 4, criteria: 2, detail: 'Do components and navigation speak the same language across screens?' },
  { name: 'Visual presentation', short: 'Visuals', maximum: 10, criteria: 5, detail: 'Do typography, color, and composition support the interface?' },
  { name: 'Deliverable quality', short: 'Structure', maximum: 4, criteria: 2, detail: 'Is the native Figma file organized into meaningful layers and hierarchy?' },
];

export const models = [
  { name: 'Claude Opus 5.5', winRate: 78.01, elo: 1219.59, overall: 86.70, scores: [84.18,82.92,86.58,92.89,92.17,86.42] },
  { name: 'GPT-6 Astra', winRate: 68.29, elo: 1137.98, overall: 85.70, scores: [85.93,82.50,87.51,91.47,92.13,69.94] },
  { name: 'Claude Sonnet 5.5', winRate: 60.19, elo: 1077.07, overall: 81.93, scores: [79.85,80.99,76.37,90.69,89.04,79.82] },
  { name: 'GPT-6.1 Sol', winRate: 59.95, elo: 1075.38, overall: 81.60, scores: [81.18,79.47,81.55,90.05,88.02,66.07] },
  { name: 'Fable 5.1', winRate: 46.76, elo: 980.77, overall: 79.07, scores: [78.29,78.67,74.46,87.48,85.55,71.36] },
  { name: 'Kimi K3', winRate: 49.54, elo: 1000.65, overall: 78.39, scores: [78.73,78.55,72.72,89.55,85.19,65.93] },
  { name: 'GLM-5.3 Flash', winRate: 46.76, elo: 980.77, overall: 76.59, scores: [75.85,76.79,69.68,85.72,84.18,69.89] },
  { name: 'SenseNova 6.8 Flash', winRate: 47.92, elo: 990.14, overall: 76.47, scores: [75.17,76.35,70.38,85.34,83.88,70.34] },
  { name: 'Qwen 3.8 Max', winRate: 48.84, elo: 995.69, overall: 75.59, scores: [73.09,76.82,64.35,86.11,82.86,81.05] },
  { name: 'DeepSeek V4 Flash', winRate: 27.31, elo: 830.87, overall: 68.93, scores: [66.39,73.24,57.44,80.41,77.60,59.15] },
  { name: 'Gemini 3.5 Flash', winRate: 14.35, elo: 701.23, overall: 68.44, scores: [61.57,73.71,55.07,83.03,75.08,71.39] },
];

export const tasks = [
  { id: 'foodgo', name: 'Foodgo', category: 'Food ordering', screen: 'Burger customization', description: 'Present burger customization with spice level, portion controls, toppings, side options, and a clear order summary.', focus: 'Hierarchy, controls & asset composition', color: '#fff0ef', frames: [{ file: 'foodgo-opus.png', width: 430, height: 1180 }, { file: 'foodgo-sol.png', width: 430, height: 932 }] },
  { id: 'fitness', name: 'Fitness', category: 'Health & fitness', screen: 'Explore', description: 'Organize a fitness discovery screen with featured workouts, exercise recommendations, challenges, and navigation.', focus: 'Content grouping & discovery', color: '#eff6df', frames: [{ file: 'fitness-opus.png', width: 390, height: 1258 }, { file: 'fitness-sol.png', width: 390, height: 844 }] },
  { id: 'mindful', name: 'MindfulMentor', category: 'Wellbeing', screen: 'Exam mode', description: 'Help students stay focused during exam preparation with a countdown, quick actions, and calming support.', focus: 'Visual emphasis & action priority', color: '#eaf5ee', frames: [{ file: 'mindful-opus.png', width: 390, height: 960 }, { file: 'mindful-sol.png', width: 390, height: 844 }] },
  { id: 'wardrobe', name: 'Wardrobe', category: 'Lifestyle', screen: 'Scan an item', description: 'Design a wardrobe scanning flow that frames a garment, presents detected details, and supports saving an item.', focus: 'Asset placement & interaction states', color: '#f4ede5', frames: [{ file: 'wardrobe-opus.png', width: 390, height: 925 }, { file: 'wardrobe-sol.png', width: 390, height: 980 }] },
  { id: 'shopping', name: 'Shopping', category: 'E-commerce', screen: 'Product details', description: 'Present a product gallery, price, ratings, size selection, delivery information, and purchase actions.', focus: 'Information density & purchase flow', color: '#f3edf7', frames: [{ file: 'shopping-opus.png', width: 375, height: 2016 }, { file: 'shopping-sol.png', width: 375, height: 812 }] },
];

export const steps = [
  { title: 'Inspect the resources', tool: 'get_metadata · get_screenshot', image: 'process-resources.png', description: 'Read the starter file and inspect the supplied brand, media, and interface elements.' },
  { title: 'Build reusable components', tool: 'use_figma', image: 'process-components.png', description: 'Compose controls and reusable elements directly in the native Figma document.' },
  { title: 'Compose the screens', tool: 'use_figma · get_screenshot', image: 'process-home.png', description: 'Arrange the content into a complete interface and inspect the rendered result.' },
  { title: 'Review and refine', tool: 'use_figma · get_screenshot', image: 'process-refine.png', description: 'Revisit layout, controls, and visual presentation using screenshot feedback.' },
  { title: 'Verify the design flow', tool: 'use_figma · get_screenshot', image: 'process-verify.png', description: 'Inspect a later interaction state as part of the multi-screen design deliverable.' },
];
