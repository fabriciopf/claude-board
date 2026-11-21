import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useLang } from './i18n';
import { mirrorBusyOnDocument } from './pending';
import './styles.css';

mirrorBusyOnDocument(document.documentElement);

// A new language remounts the app (D90): text computed outside render (memos, module helpers) follows too.
function Root() {
  const lang = useLang();
  return <App key={lang} />;
}

createRoot(document.getElementById('root')!).render(<Root />);
