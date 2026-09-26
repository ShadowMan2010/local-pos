// Boot file for the weighing station (public/weigh.html).
import { initTheme } from './ui.js';
import { renderWeighStation } from './components/weigh-station.js';

initTheme();
renderWeighStation(document.getElementById('app'));
