import { mount } from '/simple-github/panel.js';

const root = document.getElementById('app');
mount(root, { standalone: true });
root.removeAttribute('aria-live');
