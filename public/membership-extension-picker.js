// Shared admin control: relative extensions start after the verified Stripe term.
(function(){
 "use strict";
 function attach(form,config={}){
  const outer=document.createElement("div");outer.className="sng-extension-picker";
  outer.innerHTML='<label>Extend by <span class="sng-extension-fields"><select data-unit aria-label="Extension duration unit"><option value="day">Day(s)</option><option value="week">Week(s)</option><option value="month" selected>Month(s)</option><option value="year">Year(s)</option></select><input data-quantity type="number" min="1" step="1" value="1" aria-label="Number of units to extend" required></span></label><div class="sng-extension-presets" aria-label="Quick extension choices"><button type="button" data-preset="day">1 day</button><button type="button" data-preset="week">1 week</button><button type="button" data-preset="month">1 month</button><button type="button" data-preset="year">1 year</button><button type="button" data-maximum>Maximum available</button></div><p class="sng-extension-max-note" role="status">Maximum available sets the latest renewal Stripe permits for this customer (up to 2 years from the subscription billing anchor).</p><label class="sng-extension-exact"><input type="checkbox" data-exact> Use an exact renewal date instead</label>';
  const unit=outer.querySelector("[data-unit]"),quantity=outer.querySelector("[data-quantity]"),exact=outer.querySelector("[data-exact]");
  const date=config.date;
  let maximumSelected=false;
  const maximumButton=outer.querySelector("[data-maximum]");
  const limits={day:731,week:104,month:24,year:2};
  date.disabled=true;date.closest("label").hidden=true;
  const changed=()=>{delete form.dataset.extensionRequestId;delete form.dataset.requestId;if(config.feedback)config.feedback.textContent="";};
  outer.querySelectorAll("[data-preset]").forEach(b=>b.addEventListener("click",()=>{
   maximumSelected=false;exact.checked=false;unit.value=b.dataset.preset;quantity.value="1";sync();changed();
  }));
  maximumButton.addEventListener("click",()=>{maximumSelected=true;exact.checked=false;sync();changed();});
  [unit,quantity,exact].forEach(el=>el.addEventListener("change",()=>{maximumSelected=false;sync();changed();}));
  function sync(){
   date.disabled=!exact.checked;date.required=exact.checked;date.closest("label").hidden=!exact.checked;
   unit.disabled=maximumSelected||exact.checked;quantity.disabled=maximumSelected||exact.checked;
   quantity.required=!exact.checked&&!maximumSelected;quantity.max=String(limits[unit.value]||731);
   maximumButton.setAttribute("aria-pressed",maximumSelected?"true":"false");
  }
  function value(){
   if(maximumSelected)return {durationUnit:"maximum"};
   if(exact.checked){
    const d=new Date(date.value);
    if(!Number.isFinite(d.getTime()))throw Error("Choose a valid date and time.");
    return {endAt:d.toISOString()};
   }
   const n=Number(quantity.value);
   if(!Number.isSafeInteger(n)||n<1)throw Error("Enter a positive whole number.");
   if(n>limits[unit.value])throw Error("That duration may exceed Stripe\u0027s two-year limit. Choose a shorter duration or Maximum available.");
   return {durationUnit:unit.value,durationQuantity:n};
  }
  date.addEventListener("change",changed);
  date.closest("label").before(outer);
  sync();
  return {value};
 }
 window.SNGMembershipExtensionPicker={attach};
})();
