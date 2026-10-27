//! System address book, used only to suggest addresses while writing.
//! Currently macOS only (Contacts app); elsewhere it returns an empty list.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Contact {
    pub name: String,
    pub email: String,
}

/// Reads every contact that has an email address. macOS asks for permission the first time.
/// Call it off the main thread: it may block while waiting for the answer.
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
            return Err(concat!(
                "macOS denied access to Contacts. If you are running the development build (started from Terminal), ",
                "the permission is requested for Terminal rather than KanbanMail: it will work in the installed app. ",
                "Otherwise enable it in System Settings → Privacy & Security → Contacts. ",
                "Suggestions from email senders still work."
            )
            .into());
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
            return Err(format!("reading Contacts failed: {msg}"));
        }
        Ok(out.into_inner())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn system_contacts() -> Result<Vec<Contact>, String> {
    Ok(Vec::new())
}
