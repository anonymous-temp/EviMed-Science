import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter, Routes, Route} from 'react-router';
import {FrontierPage} from './src/app/routes/FrontierPage';
import {FrontierEventPage} from './src/app/routes/FrontierEventPage';
import {Toaster} from './src/components/ui/Toaster';
import './src/index.css';
createRoot(document.getElementById('root')!).render(<BrowserRouter><div style={{height:'100dvh'}}><Routes><Route path="/app/frontier/events/:eventId" element={<FrontierEventPage/>}/><Route path="*" element={<FrontierPage/>}/></Routes><Toaster/></div></BrowserRouter>);
