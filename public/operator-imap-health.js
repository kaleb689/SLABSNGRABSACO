(()=> {
  "use strict";
  const enc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const sessions=new WeakMap();
  const formatTime=value=>{
    if(!value)return "Never";
    const d=new Date(value);
    return Number.isFinite(d.getTime())?d.toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"Unavailable";
  };
  const statuses={
    healthy:"Healthy",stale:"Connected · scan overdue",error:"Connection issue",
    paused:"Paused",pending:"Awaiting first scan",not_configured:"Missing configuration"
  };
  const reasonText={
    authentication_failed:"Authentication failed — verify this inbox's app password.",
    connection_timeout:"Connection timed out — check provider availability and IMAP settings.",
    connection_closed:"Connection closed unexpectedly.",
    tls_failed:"Secure IMAP connection failed.",
    dns_failed:"IMAP host could not be reached.",
    unsupported_provider:"This provider is not supported.",
    mailbox_command_rejected:"The provider rejected the mailbox scan.",
    mailbox_scan_failed:"Mailbox scan failed. Check Render logs."
  };
  async function api(path,method="GET",body) {
    const response=await fetch(path,{
      method,credentials:"same-origin",cache:"no-store",
      ...(body===undefined?{}:{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(data.error||"The IMAP request failed.");
    return data;
  }
  const url="/api/admin/imap-health";
  function stat(label,value) {
    return '<div class="sng-imap-stat"><small>'+enc(label)+'</small><strong>'+enc(value)+'</strong></div>';
  }
  function render(host){
    const state=sessions.get(host);
    if(!state||!host.isConnected)return;
    const snapshot=state.snapshot||{inboxes:[],scanIntervalSeconds:180,running:false};
    const list=Array.isArray(snapshot.inboxes)?snapshot.inboxes:[];
    const connected=list.filter(item=>item.status==="healthy").length;
    const failed=list.filter(item=>item.status==="error"||item.status==="not_configured").length;
    const top='<div class="sng-imap-header"><div><h3>IMAP Health</h3>'+
      '<p>Only the inboxes you authorize below are scanned. Customer email accounts are not scanned for tracking.</p></div>'+
      '<div class="sng-imap-buttons"><button type="button" data-imap-action="refresh">Refresh health</button>'+
      '<button type="button" data-imap-action="scan" '+(snapshot.running?'disabled':'')+'>'
      +(snapshot.running?'Scanning…':'Scan shipping now')+'</button>'+
      '<button type="button" class="sng-imap-main-button" data-imap-action="add">Add IMAP inbox</button></div></div>'+
      '<div class="sng-imap-overview">'+stat("Approved inboxes",list.length)+
      stat("Healthy scanners",connected)+stat("Need attention",failed)+
      stat("Scan interval",Math.round((snapshot.scanIntervalSeconds||180)/60)+" minutes")+'</div>';
    const rows=list.map(item=>{
      const environment=item.source==="environment";
      const stage=statuses[item.status]||"Checking";
      const detail=item.lastError ? (reasonText[item.lastError]||"Mailbox scan failed.") : "";
      return '<article class="sng-imap-inbox" data-imap-card="'+enc(item.id)+'">'+
        '<div class="sng-imap-inbox-heading"><div><strong>'+enc(item.label||"Owner inbox")+'</strong>'+
        '<small>'+enc(item.email)+'</small></div>'+
        '<span class="sng-imap-state state-'+enc(item.status)+'">'+enc(stage)+'</span></div>'+
        '<div class="sng-imap-times">'+
        '<span>Last connected <strong>'+enc(formatTime(item.lastConnectedAt))+'</strong></span>'+
        '<span>Last scan <strong>'+enc(formatTime(item.lastScanAt))+'</strong></span>'+
        '<span>Messages checked <strong>'+enc(item.messagesExamined||0)+'</strong></span>'+
        '<span>Matched <strong>'+enc(item.matchedMessages||0)+'</strong></span>'+
        '<span>Updates found <strong>'+enc(item.candidateUpdates||0)+'</strong></span></div>'+
        (detail?'<p class="sng-imap-error">'+enc(detail)+'</p>':'')+
        '<div class="sng-imap-actions"><button type="button" data-imap-action="test" data-imap-id="'+enc(item.id)+'" '+(!item.enabled||!item.passwordConfigured?'disabled':'')+'>Test connection</button>'+
        (environment?'<span class="sng-imap-managed">Configured in Render · cannot edit here</span>':
        '<button type="button" data-imap-action="edit" data-imap-id="'+enc(item.id)+'">Edit</button>'+
        '<button type="button" data-imap-action="toggle" data-imap-id="'+enc(item.id)+'">'+(item.enabled?'Pause':'Resume')+'</button>'+
        '<button type="button" class="sng-imap-danger" data-imap-action="delete" data-imap-id="'+enc(item.id)+'">Remove</button>')+
        '</div></article>';
    }).join("");
    const current=state.editing==="new"?null:list.find(item=>item.id===state.editing);
    const form=state.editing===null?"":'<form class="sng-imap-edit" data-imap-form>'+
      '<h4>'+(current?'Edit IMAP inbox':'Add approved IMAP inbox')+'</h4>'+
      '<p>These credentials are encrypted on the server. Never enter your regular email password.</p>'+
      '<label>Inbox name (optional)<input name="label" maxlength="80" autocomplete="off" value="'+enc(current?.label||"")+'" placeholder="e.g. Target shipping inbox"></label>'+
      '<label>Email<input type="email" name="email" maxlength="254" autocomplete="off" required value="'+enc(current?.email||"")+'" placeholder="inbox@example.com"></label>'+
      '<label>IMAP provider<select name="provider"><option value="auto" '+(!current?'selected':'')+'>Detect from email</option>'+
      [['google','Google / Gmail'],['microsoft','Microsoft'],['yahoo','Yahoo']].map(([key,label])=>
        '<option value="'+key+'" '+(current?.provider===key?'selected':'')+'>'+label+'</option>').join("")+'</select></label>'+
      '<label>App password<input type="password" name="password" minlength="6" maxlength="512" autocomplete="new-password" '+
      (current?'placeholder="Leave blank to keep existing app password"':'placeholder="Provider-generated app password" required')+'></label>'+
      '<div class="sng-imap-form-actions"><button type="submit" class="sng-imap-main-button">'+(current?'Save & test':'Add & test')+'</button>'+
      '<button type="button" data-imap-action="cancel">Cancel</button></div></form>';
    host.innerHTML='<section class="sng-operator-imap" aria-label="Admin IMAP Health">'+top+
      '<p class="sng-imap-feedback" role="status" aria-live="polite">'+enc(state.message||"")+'</p>'+
      form+'<div class="sng-imap-list">'+(rows||'<p class="sng-imap-empty">No operator inboxes configured. Add one to begin shipping email scans.</p>')+
      '</div><p class="sng-imap-footnote">IMAP is read-only. Shipping messages may update an existing, exact Discord-confirmed order; they cannot create checkouts. Environment-managed inboxes remain editable in Render only.</p></section>';
  }
  async function load(host,{force=false}={}){
    const state=sessions.get(host);
    if(!state||!host.isConnected||state.working)return;
    if(!force && (state.editing!==null||host.contains(document.activeElement) &&
      document.activeElement?.matches("input, select")))return;
    try {state.snapshot=await api(url);render(host);}
    catch(error){state.message=error.message;render(host);}
  }
  async function act(host,button){
    const state=sessions.get(host);
    if(!state||state.working)return;
    const action=button.dataset.imapAction,id=button.dataset.imapId||"";
    const inbox=(state.snapshot?.inboxes||[]).find(item=>item.id===id);
    if(action==="add"||action==="edit"||action==="cancel"){
      state.editing=action==="cancel"?null:action==="add"?"new":id;
      state.message="";render(host);return;
    }
    if(action==="delete"&&!confirm("Remove this owner IMAP inbox from all future shipping scans?"))return;
    state.working=true;button.disabled=true;
    state.message=action==="scan"?"Requesting a read-only shipping scan…":
      action==="test"?"Testing secure inbox access…":"Saving IMAP inbox settings…";
    try {
      if(action==="refresh"){await api(url).then(data=>state.snapshot=data);state.message="Health refreshed.";}
      else if(action==="scan"){
        const r=await api(url+"/scan","POST",{});
        state.message=r.running?"A shipping scan is already running.":"Shipping scan started. Refresh health to view per-inbox results.";
      }
      else if(action==="test"){
        const r=await api(url+"/"+encodeURIComponent(id)+"/test","POST",{});
        state.message=r.connected?"Secure IMAP login and INBOX read access confirmed.":"Connection failed: "+(reasonText[r.status]||r.status);
      }
      else if(action==="toggle"&&inbox){
        const r=await api(url+"/"+encodeURIComponent(id),"PUT",{
          email:inbox.email,label:inbox.label,provider:inbox.provider,
          enabled:!inbox.enabled
        });
        state.message=r.entry?.enabled?"Inbox resumed and connection tested.":"Inbox paused. Automatic scans will skip it.";
      }
      else if(action==="delete"&&inbox){
        await api(url+"/"+encodeURIComponent(id),"DELETE");
        state.message="Inbox removed from approved scans.";
      }
      else return;
      state.snapshot=await api(url);
    }catch(error){state.message=error.message;}
    finally{state.working=false;render(host);}
  }
  async function submit(host,form){
    const state=sessions.get(host);
    if(!state||state.working)return;
    const values=new FormData(form);
    const email=String(values.get("email")||"").trim();
    const label=String(values.get("label")||"").trim();
    const provider=String(values.get("provider")||"auto");
    const password=String(values.get("password")||"");
    const id=state.editing!=="new"?state.editing:null;
    state.working=true;
    const submitButton=form.querySelector('[type="submit"]');
    if(submitButton)submitButton.disabled=true;
    const message=host.querySelector(".sng-imap-feedback");
    if(message)message.textContent="Saving encrypted IMAP login and testing INBOX access…";
    try {
      const existing=id?(state.snapshot?.inboxes||[]).find(item=>item.id===id):null;
      const result=await api(id?url+"/"+encodeURIComponent(id):url,id?"PUT":"POST",{
        label,email,provider,password,enabled:existing?existing.enabled:true
      });
      state.editing=null;
      const messageResult=result.connection;
      state.message=messageResult?.connected ?
        "Inbox saved. Secure login and read access confirmed.":
        "Inbox saved, but connection needs attention: "+(reasonText[messageResult?.status]||messageResult?.status||"Check settings.");
      state.snapshot=await api(url);
    }catch(error){
      state.message=error.message;
    }finally{state.working=false;render(host);}
  }
  function mount(host){
    if(!host)return;
    if(sessions.has(host))return;
    sessions.set(host,{snapshot:null,editing:null,message:"Loading approved inboxes…",working:false});
    host.setAttribute("data-imap-health-root","");
    host.addEventListener("click",event=>{
      const button=event.target.closest("button[data-imap-action]");
      if(button&&host.contains(button))void act(host,button);
    });
    host.addEventListener("submit",event=>{
      const form=event.target.closest("form[data-imap-form]");
      if(!form||!host.contains(form))return;
      event.preventDefault();void submit(host,form);
    });
    void load(host,{force:true});
  }
  window.SNGOperatorImapHealth={mount,refresh:host=>load(host,{force:true})};
  setInterval(()=>{
    if(document.hidden)return;
    for(const host of document.querySelectorAll("[data-imap-health-root]"))
      void load(host);
  },60000);
})();
