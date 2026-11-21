import { createRoot } from 'react-dom/client';
import { App } from './App';
import { mirrorBusyOnDocument } from './pending';
import './styles.css';

mirrorBusyOnDocument(document.documentElement);

createRoot(document.getElementById('root')!).render(<App />);
