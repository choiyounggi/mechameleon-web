import './style.css';
import { createAppContext } from './net';
import { bootstrap } from './app';

const root = document.getElementById('root');
if (!root) {
  throw new Error('missing #root element');
}

bootstrap(root, createAppContext());
