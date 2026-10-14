/**
 * main.tsx —— 入口：样式装配顺序 tokens → base → animations → components → layout，
 * React 18 createRoot 挂载。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/animations.css';
import './styles/components.css';
import './components/layout/layout.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 容器缺失（index.html 被破坏？）');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
