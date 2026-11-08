// App entry. The crypto polyfill must load before anything imports Gun SEA or
// libsignal, because both read globalThis.crypto when their modules load.
import './src/db/polyfills';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
