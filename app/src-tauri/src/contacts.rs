//! Rubrica di sistema, usata solo per suggerire indirizzi mentre si scrive.
//! Per ora supportata solo su macOS (app Contatti); altrove restituisce un elenco vuoto.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Contact {
    pub name: String,
    pub email: String,
}

/// Legge tutti i contatti con un indirizzo email. La prima volta macOS chiede il permesso.
/// Va chiamata fuori dal thread principale: può restare in attesa della risposta.
#[cfg(target_os = "macos")]
pub fn system_contacts() -> Result<Vec<Contact>, String> {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::AllocAnyThread;
    use objc2_contacts::{
        CNAuthorizationStatus, CNContact, CNContactEmailAddressesKey, CNContactFamilyNameKey,
        CNContactFetchRequest, CNContactGivenNameKey, CNContactOrganizationNameKey, CNContactStore,
        CNEntityType, CNKeyDescriptor,
    };
    use objc2_foundation::{NSArray, NSError};
    use std::cell::RefCell;
    use std::ptr::NonNull;

    unsafe {
        let status = CNContactStore::authorizationStatusForEntityType(CNEntityType::Contacts);
        if status == CNAuthorizationStatus::Denied || status == CNAuthorizationStatus::Restricted {
            return Err("accesso ai Contatti negato: abilitalo in Impostazioni di Sistema → Privacy e sicurezza → Contatti".into());
        }
        let store = CNContactStore::new();
        let keys: [&ProtocolObject<dyn CNKeyDescriptor>; 4] = [
            ProtocolObject::from_ref(CNContactGivenNameKey),
            ProtocolObject::from_ref(CNContactFamilyNameKey),
            ProtocolObject::from_ref(CNContactOrganizationNameKey),
            ProtocolObject::from_ref(CNContactEmailAddressesKey),
        ];
        let keys = NSArray::from_slice(&keys);
        let request = CNContactFetchRequest::initWithKeysToFetch(CNContactFetchRequest::alloc(), &keys);

        let out = RefCell::new(Vec::new());
        let block = RcBlock::new(|contact: NonNull<CNContact>, _stop: NonNull<Bool>| {
            let c = contact.as_ref();
            let full = format!("{} {}", c.givenName(), c.familyName()).trim().to_string();
            let name = if full.is_empty() { c.organizationName().to_string() } else { full };
            for labeled in c.emailAddresses().iter() {
                let email = labeled.value().to_string();
                if !email.is_empty() {
                    out.borrow_mut().push(Contact { name: name.clone(), email });
                }
            }
        });
        let mut error: Option<Retained<NSError>> = None;
        let ok = store.enumerateContactsWithFetchRequest_error_usingBlock(&request, Some(&mut error), &block);
        drop(block);
        if !ok {
            let msg = error.map(|e| e.localizedDescription().to_string()).unwrap_or_default();
            return Err(format!("lettura dei Contatti non riuscita: {msg}"));
        }
        Ok(out.into_inner())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn system_contacts() -> Result<Vec<Contact>, String> {
    Ok(Vec::new())
}
