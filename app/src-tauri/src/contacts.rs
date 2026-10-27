//! System address book, used only to suggest addresses while writing.
//! Currently macOS only (Contacts app); elsewhere it returns an empty list.

use serde::Serialize;

/// Error text when macOS refuses access; the UI recognises it to offer a shortcut.
pub const DENIED: &str = "macOS has not allowed KanbanMail to read your Contacts.";

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
        // No status check up front: on ad-hoc signed builds macOS can report "denied"
        // while reading works. Try to read, and look at the status only if it fails.
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
            let status = CNContactStore::authorizationStatusForEntityType(CNEntityType::Contacts);
            if status == CNAuthorizationStatus::Denied || status == CNAuthorizationStatus::Restricted {
                return Err(DENIED.into());
            }
            let msg = error.map(|e| e.localizedDescription().to_string()).unwrap_or_default();
            return Err(format!("Reading Contacts failed: {msg}"));
        }
        Ok(out.into_inner())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn system_contacts() -> Result<Vec<Contact>, String> {
    Ok(Vec::new())
}

/// Opens System Settings on Privacy & Security → Contacts.
pub fn open_privacy_settings() {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts")
        .spawn();
}
