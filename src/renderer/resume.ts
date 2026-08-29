import { getBridge } from './bridge.ts';

const bridge = getBridge();
const pill = document.getElementById('pill');
pill?.addEventListener('click', () => bridge.resume());
