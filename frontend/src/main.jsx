import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import SiteRouter from './SiteRouter.jsx';

createRoot(document.getElementById('root')).render(
    <StrictMode>
        <SiteRouter />
    </StrictMode>
);
