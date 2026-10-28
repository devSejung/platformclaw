package com.iflytek.skillhub.domain.skill;

import com.iflytek.skillhub.domain.shared.exception.LocalizedDomainException;

/** Immutable identity failures must remain distinct from archive validation. */
public class PlatformclawPublicationConflict extends LocalizedDomainException {
    public PlatformclawPublicationConflict(String message) { super(message); }
    @Override public int statusCode() { return 409; }
}
