//! System address book, used only to suggest addresses while writing.
//! Currently macOS only (Contacts app); elsewhere it returns an empty list.

use serde::Serialize;

/// Error text when macOS refuses access; the UI recognises it to offer a shortcut.
pub const DENIED: &str = "macOS has not allowed Pigeonhole to read your Contacts.";

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
        CNAuthorizationStatus, CNContact, CNContactEmailAddressesKey, CNContactFamilyNameKey, CNContactFetchRequest,
        CNContactGivenNameKey, CNContactOrganizationNameKey, CNContactStore, CNEntityType, CNKeyDescriptor,
    };
    use objc2_foundation::{NSArray, NSError};
    use std::cell::RefCell;
    use std::ptr::NonNull;

    unsafe {
        let store = CNContactStore::new();
        // The first time, ask explicitly: this shows the macOS dialog and adds the app to
        // Privacy & Security. No other status check up front: on ad-hoc signed builds macOS
        // can report "denied" while reading works, so try to read and look at it only on failure.
        if CNContactStore::authorizationStatusForEntityType(CNEntityType::Contacts)
            == CNAuthorizationStatus::NotDetermined
        {
            let (answered, answer) = std::sync::mpsc::channel();
            let done = RcBlock::new(move |_granted: Bool, _error: *mut NSError| {
                let _ = answered.send(());
            });
            store.requestAccessForEntityType_completionHandler(CNEntityType::Contacts, &done);
            drop(done);
            let _ = answer.recv();
        }
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
            let name = if full.is_empty() {
                c.organizationName().to_string()
            } else {
                full
            };
            for labeled in c.emailAddresses().iter() {
                let email = labeled.value().to_string();
                if !email.is_empty() {
                    out.borrow_mut().push(Contact {
                        name: name.clone(),
                        email,
                    });
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

/// Shows the contact with this address in the Contacts app, creating it
/// first (with the name split into first and last) when there is none.
/// Returns true when it was created. Call it off the main thread.
#[cfg(target_os = "macos")]
pub fn open_contact(name: &str, email: &str) -> Result<bool, String> {
    use block2::RcBlock;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2_contacts::{
        CNAuthorizationStatus, CNContact, CNContactEmailAddressesKey, CNContactStore, CNEntityType, CNKeyDescriptor,
        CNLabelWork, CNLabeledValue, CNMutableContact, CNSaveRequest,
    };
    use objc2_foundation::{NSArray, NSError, NSString};

    let email = email.trim();
    if !email.contains('@') {
        return Err("not an email address".into());
    }
    unsafe {
        let store = CNContactStore::new();
        if CNContactStore::authorizationStatusForEntityType(CNEntityType::Contacts)
            == CNAuthorizationStatus::NotDetermined
        {
            let (answered, answer) = std::sync::mpsc::channel();
            let done = RcBlock::new(move |_granted: Bool, _error: *mut NSError| {
                let _ = answered.send(());
            });
            store.requestAccessForEntityType_completionHandler(CNEntityType::Contacts, &done);
            drop(done);
            let _ = answer.recv();
        }
        let denied = || {
            let status = CNContactStore::authorizationStatusForEntityType(CNEntityType::Contacts);
            status == CNAuthorizationStatus::Denied || status == CNAuthorizationStatus::Restricted
        };
        let keys: [&ProtocolObject<dyn CNKeyDescriptor>; 1] = [ProtocolObject::from_ref(CNContactEmailAddressesKey)];
        let keys = NSArray::from_slice(&keys);
        let predicate = CNContact::predicateForContactsMatchingEmailAddress(&NSString::from_str(email));
        let found = match store.unifiedContactsMatchingPredicate_keysToFetch_error(&predicate, &keys) {
            Ok(list) => list.firstObject().map(|c| c.identifier().to_string()),
            Err(_) if denied() => return Err(DENIED.into()),
            Err(e) => return Err(format!("Reading Contacts failed: {}", e.localizedDescription())),
        };
        let (identifier, created) = match found {
            Some(id) => (id, false),
            None => {
                let contact = CNMutableContact::new();
                let name = name.trim();
                let name = if name.eq_ignore_ascii_case(email) { "" } else { name };
                match name.rsplit_once(' ') {
                    Some((first, last)) => {
                        contact.setGivenName(&NSString::from_str(first.trim()));
                        contact.setFamilyName(&NSString::from_str(last.trim()));
                    }
                    None => contact.setGivenName(&NSString::from_str(name)),
                }
                let value = NSString::from_str(email);
                let labeled = CNLabeledValue::<NSString>::labeledValueWithLabel_value(Some(CNLabelWork), &value);
                contact.setEmailAddresses(&NSArray::from_retained_slice(&[labeled]));
                let request = CNSaveRequest::new();
                request.addContact_toContainerWithIdentifier(&contact, None);
                match store.executeSaveRequest_error(&request) {
                    Ok(()) => (contact.identifier().to_string(), true),
                    Err(_) if denied() => return Err(DENIED.into()),
                    Err(e) => return Err(format!("Saving the contact failed: {}", e.localizedDescription())),
                }
            }
        };
        let _ = std::process::Command::new("open")
            .arg(format!("addressbook://{identifier}"))
            .spawn();
        Ok(created)
    }
}

#[cfg(not(target_os = "macos"))]
pub fn open_contact(_name: &str, _email: &str) -> Result<bool, String> {
    Err("Contacts are available on macOS only".into())
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
