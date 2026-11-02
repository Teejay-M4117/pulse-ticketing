let events = [], selectedEvent = null;
const money = (minor, currency="KES") => new Intl.NumberFormat("en-KE",{style:"currency",currency,maximumFractionDigits:2}).format(minor/100);
const $ = id => document.getElementById(id);
async function loadEvents(){
  const list=$("event-list");
  try{
    const r=await fetch("/api/events"); if(!r.ok) throw new Error("Could not load events");
    events=await r.json();
    if(!events.length){list.innerHTML='<p>No upcoming events right now. Please check back soon.</p>';return;}
    list.innerHTML=events.map((e,i)=>`<article class="event-card"><div class="event-visual" style="background:${i%3===0?'#20251a':i%3===1?'#32254c':'#8a402f'};color:${i%3===1?'#d6c7ff':'#d9ff63'}"><small>PULSE TICKETS · EVENT ${String(i+1).padStart(2,"0")}</small><strong>${escapeHtml(e.title).replace(/\s+/g,"<br>")}</strong><small>${escapeHtml(e.venue)}</small></div><div class="event-content"><h3>${escapeHtml(e.title)}</h3><p>${escapeHtml(e.description)}</p><div class="event-meta"><span>◷ ${formatDate(e.event_date)}</span><span>${Math.max(0,e.capacity-e.sold)} left</span></div><div class="event-meta"><strong>${money(e.price)}</strong><span>per ticket</span></div><button class="button event-buy" data-id="${e.id}" ${e.capacity-e.sold<=0?"disabled":""}>${e.capacity-e.sold<=0?"Sold out":"Get tickets"} <span>↗</span></button></div></article>`).join("");
    list.querySelectorAll("button[data-id]").forEach(b=>b.addEventListener("click",()=>openModal(Number(b.dataset.id))));
  }catch(e){list.innerHTML='<p>Events could not load. Check that the server is running and refresh.</p>';}
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function formatDate(s){const d=new Date(s);return isNaN(d)?s:d.toLocaleString("en-KE",{dateStyle:"medium",timeStyle:"short"});}
function openModal(id){selectedEvent=events.find(e=>e.id===id);if(!selectedEvent)return;$("modal-title").textContent=selectedEvent.title;$("modal-detail").textContent=`${selectedEvent.venue} · ${formatDate(selectedEvent.event_date)}`;$("quantity").value="1";$("form-error").textContent="";updateTotal();$("modal").classList.remove("hidden");}
function updateTotal(){if(selectedEvent)$("total").textContent=`Total: ${money(selectedEvent.price*Number($("quantity").value))}`;}
$("quantity").addEventListener("change",updateTotal);
$("close-modal").addEventListener("click",()=>$("modal").classList.add("hidden"));
$("modal").addEventListener("click",e=>{if(e.target===$("modal"))$("modal").classList.add("hidden");});
$("checkout-form").addEventListener("submit",async e=>{
  e.preventDefault(); if(!selectedEvent)return;
  const button=$("pay-button");button.disabled=true;button.textContent="Connecting to Paystack…";$("form-error").textContent="";
  try{
    const r=await fetch("/api/checkout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({eventId:selectedEvent.id,name:$("buyer-name").value,email:$("buyer-email").value,quantity:Number($("quantity").value)})});
    const data=await r.json();if(!r.ok)throw new Error(data.error||"Checkout failed");
    location.href=data.checkoutUrl;
  }catch(err){$("form-error").textContent=err.message;button.disabled=false;button.innerHTML='Continue to Paystack <span>↗</span>';}
});
loadEvents();