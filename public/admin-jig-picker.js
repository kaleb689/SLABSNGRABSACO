(() => {
  "use strict";
  const route = "/api/admin/jig-options";
  let catalog = null, postalConfigured = false, modal = null, originalButton = null;
  function element(tag,className,text) {
    const node=document.createElement(tag);
    if(className)node.className=className;
    if(text!=null)node.textContent=String(text);
    return node;
  }
  async function ensureCatalog() {
    if(catalog)return catalog;
    const response=await fetch(route,{credentials:"same-origin",cache:"no-store"});
    const body=await response.json().catch(()=>({}));
    if(!response.ok || !Array.isArray(body.options))throw Error(body.error||"Unable to load jig choices.");
    catalog=body.options;
    postalConfigured=body.postalVerificationConfigured===true;
    return catalog;
  }
  function ensureModal() {
    if(modal)return modal;
    modal=element("div","admin-jig-picker-overlay");
    modal.id="adminJigChoiceModal";
    modal.hidden=true;
    const panel=element("section","admin-jig-picker-panel");
    panel.setAttribute("role","dialog");
    panel.setAttribute("aria-modal","true");
    panel.setAttribute("aria-labelledby","adminJigPickerHeading");
    const heading=element("h2","", "Choose address variations");
    heading.id="adminJigPickerHeading";
    const lead=element("p","","Select the exact formats you want to allow. Each generated profile uses only one selected change. The first profile for each main address stays unchanged.");
    const warn=element("p","admin-jig-warning","Experimental spellings, added house letters/fractions and floor/building formats are NOT USPS-verified and may be rejected or delivered to the wrong location.");
    const toolbar=element("div","admin-jig-picker-toolbar");
    const standard=element("button","","Select standard");
    const all=element("button","","Select all");
    const clear=element("button","","Clear");
    [standard,all,clear].forEach(b=>b.type="button");
    toolbar.append(standard,all,clear);
    const choices=element("div","admin-jig-picker-groups");
    choices.id="adminJigPickerGroups";
    const footer=element("div","admin-jig-picker-footer");
    const status=element("p","admin-jig-picker-status");
    status.id="adminJigChoiceStatus";
    status.setAttribute("role","status");
    const cancel=element("button","admin-jig-picker-cancel","Cancel");
    const confirm=element("button","admin-jig-picker-confirm","Apply selected jigs");
    cancel.type=confirm.type="button";
    footer.append(cancel,confirm);
    panel.append(heading,lead,warn,toolbar,choices,status,footer);
    modal.append(panel);
    document.body.append(modal);
    cancel.addEventListener("click",closeModal);
    modal.addEventListener("click",e=>{if(e.target===modal)closeModal();});
    document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!modal.hidden)closeModal();});
    const checkboxes=()=>[...choices.querySelectorAll('input[type="checkbox"]')];
    standard.addEventListener("click",()=>checkboxes().forEach(x=>{x.checked=!x.disabled&&x.dataset.risk==="standard";}));
    all.addEventListener("click",()=>checkboxes().forEach(x=>{x.checked=!x.disabled;}));
    clear.addEventListener("click",()=>checkboxes().forEach(x=>{x.checked=false;}));
    confirm.addEventListener("click",async()=>{
      const selected=checkboxes().filter(x=>x.checked).map(x=>x.value);
      if(!selected.length){status.textContent="Select at least one jig format.";return;}
      // Remember toolbar selections too, not only individually clicked boxes.
      try {localStorage.setItem("adminJigCheckboxSelection",JSON.stringify(selected));} catch {}
      confirm.disabled=true;cancel.disabled=true;
      status.textContent="Applying your selected address rules...";
      try {
        await executeJig(originalButton,selected);
        modal.hidden=true;
        originalButton=null;
      } catch(error) {
        status.textContent=error.message||"Unable to jig address.";
      } finally {
        confirm.disabled=false;cancel.disabled=false;
      }
    });
    return modal;
  }
  function closeModal() {if(modal)modal.hidden=true;originalButton=null;}
  async function openPicker(button) {
    const dialog=ensureModal(),status=dialog.querySelector("#adminJigChoiceStatus");
    originalButton=button;status.textContent="Loading available jig formats...";
    dialog.hidden=false;
    const groups=dialog.querySelector("#adminJigPickerGroups");
    try {
      const options=await ensureCatalog();
      const remembered=JSON.parse(localStorage.getItem("adminJigCheckboxSelection")||"null");
      // Previously saved per-street toggles are now one address-aware control.
      const selected=Array.isArray(remembered)?new Set(remembered.map(id=>
        /^suffix\.(?:ln|ave|st|rd|dr|ter|blvd|ct|cir|pkwy|trl|hwy|pl|wy|ctr|mnr)(?:\.full)?$/.test(id)?"suffix.matching":id)):null;
      groups.replaceChildren();
      const grouped=new Map();
      for(const option of options) {
        if(!grouped.has(option.group))grouped.set(option.group,[]);
        grouped.get(option.group).push(option);
      }
      for(const [title,items] of grouped) {
        const set=element("fieldset","admin-jig-picker-group");
        const legend=element("legend","",title);
        set.append(legend);
        for(const option of items) {
          const label=element("label","admin-jig-picker-choice");
          const input=element("input");
          input.type="checkbox";input.value=option.id;input.dataset.risk=option.risk;
          input.disabled=(option.id==="zip.four"||option.id==="city.alternate")&&!postalConfigured;
          input.checked=!input.disabled&&(selected?selected.has(option.id):option.risk==="standard");
          const caption=element("span","",option.label);
          if(option.risk==="experimental")caption.append(element("small","","Experimental"));
          label.append(input,caption);set.append(label);
        }
        groups.append(set);
      }
      groups.addEventListener("change",()=>{
        const value=[...groups.querySelectorAll('input:checked')].map(x=>x.value);
        try{localStorage.setItem("adminJigCheckboxSelection",JSON.stringify(value));}catch{}
      },{once:false});
      status.textContent=postalConfigured
        ? "USPS ZIP+4 and alternative mailing cities are checked against each customer's actual source address; unverified choices are skipped."
        : "Postal city and ZIP+4 verification is unavailable until USPS_CLIENT_ID and USPS_CLIENT_SECRET are configured on Render. Other JIG options remain available.";
    } catch(error) {status.textContent=error.message||"Unable to load options.";}
  }
  function requestBody(button) {
    if(button.hasAttribute("data-jig-attach-payment"))return {path:"/api/admin/submissions/"+encodeURIComponent(button.dataset.jigAttachPayment)+"/jig-attach-payment",data:{},orderId:button.dataset.jigAttachPayment};
    if(button.hasAttribute("data-gifted-jig")) {
      const form=button.closest(".gifted-profile-autopopulate-form");
      if(!form)throw Error("Open the gifted or rented profile first.");
      const selected=form.querySelector("[data-gifted-address-select]")?.value||"";
      const panel=form.querySelector("[data-managed-manual-address-panel]");
      const manual=Boolean(panel&&!panel.hidden);
      const fd=new FormData(form);
      const address={};
      for(const key of ["manualFirstName","manualLastName","manualAddress","manualAddress2","manualCity","manualState","manualZip","manualCountry"]) {
        const value=form.elements[key]?.value||fd.get(key)||"";
        const renames={manualFirstName:"firstName",manualLastName:"lastName",manualAddress:"address",manualAddress2:"address2",manualCity:"city",manualState:"state",manualZip:"zip",manualCountry:"country"};
        address[renames[key]]=value;
      }
      const type=form.dataset.managedType||"free",id=button.dataset.giftedJig;
      return {path:"/api/admin/managed-memberships/"+encodeURIComponent(type)+"/"+encodeURIComponent(id)+"/jig-address",
        data:{savedAddressId:manual?"":selected,manualAddress:manual?address:null},
        orderId:form.closest(".customer-order")?.dataset.id};
    }
    if(button.hasAttribute("data-linked-jig")){
      const type=button.dataset.linkedJigType,id=button.dataset.linkedJig;
      const form=button.closest(".linked-profile-detail")?.querySelector("[data-linked-edit-form]");
      if(!form)throw Error("Open the linked profile information first.");
      const fd=new FormData(form);const address={};
      for(const key of ["firstName","lastName","phone","address","address2","city","state","zip","country"])address[key]=fd.get(key)||"";
      return {path:"/api/admin/managed-memberships/"+encodeURIComponent(type)+"/"+encodeURIComponent(id)+"/jig-address",
        data:{manualAddress:address},orderId:button.closest(".customer-order")?.dataset.id};
    }
    throw Error("Unknown address jig action.");
  }
  async function executeJig(button,jigOptions){
    if(!button||!button.isConnected)throw Error("Profile changed while picker was open. Open it again.");
    const request=requestBody(button);
    button.disabled=true;
    try{
      const response=await fetch(request.path,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({...request.data,jigOptions})});
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw Error(result.error||"Address jig was not saved.");
      if(request.orderId&&typeof window.loadAdminLinkedProfiles==="function"){
        await window.loadAdminLinkedProfiles(request.orderId);
      }else if(typeof window.load==="function"){await window.load();}
      if(result.unchanged)alert(result.message||"Kept the original unchanged for this address group.");
      else if(request.path.includes("jig-attach-payment"))alert(result.message||"Jig and payment updates saved.");
      return result;
    }finally{button.disabled=false;}
  }
  // Capture on window BEFORE legacy document-level listeners, including capture listeners.
  window.addEventListener("click",event=>{
    const button=event.target.closest?.("[data-gifted-jig],[data-linked-jig],[data-jig-attach-payment]");
    if(!button||!document.getElementById("dashboard")||document.getElementById("dashboard").hidden||button.disabled)return;
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
    void openPicker(button);
  },true);
})();