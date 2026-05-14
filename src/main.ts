import './styles.css';
import { mountApp } from './ui/render';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');
mountApp(root);
