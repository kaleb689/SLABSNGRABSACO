const state = { tier: 1, plans: {
  1:{name:"Tier 1",profiles:1,amount:30},
  2:{name:"Tier 2",profiles:2,amount:50},
  3:{name:"Tier 3",profiles:3,amount:80}
}};

function go(page){
  const target = document.getElementById(page);
  if(!target) return;
  document.querySelectorAll(".page").forEach(x=>x.classList.remove("active"));
  target.classList.add("active");
  document.querySelectorAll(".nav-link[data-page]").forEach(x=>x.classList.toggle("active",x.dataset.page===page));
  if(location.hash !== `#${page}`) history.replaceState(null,"",`#${page}`);
  window.scrollTo({top:0,behavior:"smooth"});
}
function selectTier(tier){
  state.tier=tier;
  document.getElementById("selected-plan").textContent =
    `${state.plans[tier].name} — $${state.plans[tier].amount}/month`;
  go("profile");
}
document.querySelectorAll("[data-page]").forEach(el=>el.addEventListener("click",(event)=>{
  event.preventDefault();
  go(el.dataset.page);
}));
window.addEventListener("hashchange",()=>{
  const page=location.hash.slice(1);
  if(["home","pricing","profile","guide"].includes(page)) go(page);
});
const initialPage=location.hash.slice(1);
if(["home","pricing","profile","guide"].includes(initialPage)) go(initialPage);
document.querySelectorAll("[data-select]").forEach(el=>el.addEventListener("click",()=>selectTier(Number(el.dataset.select))));

const params = new URLSearchParams(location.search);
if(params.get("payment")==="success") alert("Payment completed. Your profile will be processed after Stripe confirms the payment.");
if(params.get("payment")==="cancelled") alert("Checkout was cancelled. You can return and try again.");

document.getElementById("profile-form").addEventListener("submit", async (event)=>{
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("form-message");
  const all = Object.fromEntries(new FormData(form).entries());
  const secretKeys = ["acoEmail","acoPassword","cardLabel","cardholder","acoCardNumber","expMonth","expYear"];
  const secrets = Object.fromEntries(secretKeys.map(k => [k, all[k] || ""]));
  const cvvConfirmed = all.cvvConfirmed === "yes";
  const profile = {...all};
  secretKeys.forEach(k => delete profile[k]);
  delete profile.confirm;
  delete profile.cvvConfirmed;
  message.textContent = "Encrypting setup information and preparing Stripe checkout…";
  try{
    const response = await fetch("/api/create-checkout-session",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({tier:state.tier,profile,secrets,cvvConfirmed})
    });
    const data = await response.json();
    if(!response.ok) throw new Error(data.error || "Checkout could not be started.");
    window.location.href=data.url;
  }catch(error){
    message.textContent=error.message;
  }
});

const yearSelect=document.querySelector('[name="expYear"]');
if(yearSelect){const y=new Date().getFullYear();for(let i=0;i<15;i++){const o=document.createElement("option");o.value=String(y+i);o.textContent=String(y+i);yearSelect.appendChild(o)}}
const showPass=document.getElementById("show-pass");
if(showPass){showPass.addEventListener("click",()=>{const input=document.querySelector('[name="acoPassword"]');const show=input.type==="password";input.type=show?"text":"password";showPass.textContent=show?"Hide":"Show"})}

async function adminLoad(){
  const r=await fetch("/api/admin/submissions");
  if(r.status===401){document.getElementById("admin-login").classList.remove("hidden");document.getElementById("admin-panel").classList.add("hidden");return}
  const data=await r.json();
  document.getElementById("admin-login").classList.add("hidden");document.getElementById("admin-panel").classList.remove("hidden");
  const list=document.getElementById("admin-list");
  list.innerHTML=data.length?data.map(x=>`<article class="admin-card">
    <div class="admin-card-head"><div><strong>${escapeHtml(x.profile.firstName)} ${escapeHtml(x.profile.lastName)}</strong><small>${escapeHtml(x.plan.name)} · $${x.plan.amount}/month · ${new Date(x.paidAt).toLocaleString()}</small></div><span class="paid-pill">PAID</span></div>
    <div class="admin-grid">
      <div><label>Profile</label><span>${escapeHtml(x.profile.profileName)}</span></div><div><label>Contact</label><span>${escapeHtml(x.profile.email)} · ${escapeHtml(x.profile.phone)}</span></div>
      <div class="wide"><label>Shipping</label><span>${escapeHtml([x.profile.address,x.profile.address2,x.profile.city,x.profile.state,x.profile.zip,x.profile.country].filter(Boolean).join(", "))}</span></div>
      <div><label>ACO / IMAP Email</label><span>${escapeHtml(x.secrets.acoEmail)}</span></div><div><label>ACO Email Password</label><span class="secret-value">${escapeHtml(x.secrets.acoPassword)}</span></div>
      <div><label>Card Label</label><span>${escapeHtml(x.secrets.cardLabel)}</span></div><div><label>Cardholder</label><span>${escapeHtml(x.secrets.cardholder)}</span></div>
      <div class="wide"><label>ACO Card</label><span class="secret-value">${escapeHtml(formatCard(x.secrets.acoCardNumber))} · Exp ${escapeHtml(x.secrets.expMonth)}/${escapeHtml(x.secrets.expYear)}</span></div><div><label>CVV Status</label><span>${x.cvvConfirmed ? "Confirmed by customer ✓" : "Not confirmed"}</span></div>
    </div>
    <div class="admin-actions"><button class="secondary" onclick="deleteSubmission('${x.id}')">Delete sensitive package</button></div>
  </article>`).join(""):`<div class="notice">No paid submissions are available.</div>`;
}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function formatCard(v){return String(v||"").replace(/(\d{4})(?=\d)/g,"$1 ")}
document.getElementById("admin-login-form")?.addEventListener("submit",async e=>{
  e.preventDefault();const m=document.getElementById("admin-login-message");
  const r=await fetch("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("admin-password").value})});
  if(!r.ok){m.textContent="Incorrect password or too many attempts.";return}m.textContent="";document.getElementById("admin-password").value="";await adminLoad();
});
document.getElementById("admin-logout")?.addEventListener("click",async()=>{await fetch("/api/admin/logout",{method:"POST"});await adminLoad()});
window.deleteSubmission=async id=>{if(!confirm("Permanently delete this customer's sensitive package? This cannot be undone."))return;const r=await fetch(`/api/admin/submissions/${id}`,{method:"DELETE"});if(r.ok)await adminLoad()};
document.querySelector('[data-page="admin"]')?.addEventListener("click",adminLoad);
