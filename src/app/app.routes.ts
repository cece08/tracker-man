import { Routes } from '@angular/router';
import { HomePage } from './pages/home';
import { CreatePage } from './pages/create';
import { SessionPage } from './pages/session';

export const routes: Routes = [
  { path: '', component: HomePage },
  { path: 'create', component: CreatePage },
  { path: 'session/:code', component: SessionPage },
  { path: '**', redirectTo: '' },
];
