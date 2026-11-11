(() => {
  const pages = {management:'management',dashboard:'mind',connections:'connectors',tasks:'automations',telegram:'telegram',notes:'assistant-notes',inbox:'assistant-inbox',settings:'assistant-settings'};
  const embedded = new URLSearchParams(location.search).get('embedded') === '1';
  if (!embedded && window.top === window.self) {
    location.replace('/#/' + (pages[location.hash.slice(1)] || 'management'));
    return;
  }
  document.documentElement.classList.add('embedded');
  function theme() {
    let value = ''; try { value = parent.document.documentElement.dataset.theme || localStorage.getItem('hub-theme') || ''; } catch {}
    if (value === 'dark' || value === 'light') document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
  }
  theme();
  let observer;
  if (parent !== window) {
    observer = new MutationObserver(theme);
    observer.observe(parent.document.documentElement, {attributes:true,attributeFilter:['data-theme']});
  }
  addEventListener('storage', theme);
  addEventListener('click', event => {
    const link=event.target.closest?.('a[href]'); if(!link || event.ctrlKey || event.metaKey || event.shiftKey || event.button) return;
    const url=new URL(link.href,location.href);
    if(parent!==window && url.origin===location.origin && url.pathname==='/') {event.preventDefault();parent.location.href=url.href;}
  });
  addEventListener('hashchange', () => parent.postMessage({type:'conclave-assistant-route',page:location.hash.slice(1)},location.origin));
  addEventListener('pagehide', () => observer?.disconnect(), {once:true});
})();
