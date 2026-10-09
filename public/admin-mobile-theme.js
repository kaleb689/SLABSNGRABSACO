(() => {
 const key='sng-admin-mobile-theme';
 let theme='dark';
 try{theme=localStorage.getItem(key)||localStorage.getItem('sng-admin-theme')||'dark';}catch{}
 theme=theme==='light'?'light':'dark';
 const set=()=>{
   document.documentElement.dataset.adminMobileTheme=theme;
   const button=document.getElementById('admin-theme-toggle');
   if(button){button.textContent=theme==='light'?'☾':'☀';button.setAttribute('aria-label',theme==='light'?'Switch to dark mode':'Switch to light mode');button.title=button.getAttribute('aria-label');}
   const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=theme==='light'?'#f0f5fc':'#080b14';
 };
 const init=()=>{
   const refresh=document.getElementById('refresh');
   if(refresh&&!document.getElementById('admin-theme-toggle')){
     const btn=document.createElement('button');btn.id='admin-theme-toggle';btn.type='button';
     btn.addEventListener('click',()=>{theme=theme==='light'?'dark':'light';try{localStorage.setItem(key,theme);localStorage.setItem('sng-admin-theme',theme);}catch{}set();});
     refresh.before(btn);
   }
   set();
 };
 set();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
