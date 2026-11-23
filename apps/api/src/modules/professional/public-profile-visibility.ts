export const visibleProfessionals = `
        FROM public_professional_regions r
        JOIN public_professional_profiles p ON p.id = r.profile_id
        LEFT JOIN users u ON u.id = p.agent_id
        LEFT JOIN organizations o ON o.id = p.agency_id
        WHERE p.published_at <= now()
          AND ((u.active AND u.role = 'agent'
            AND u.registration_approval_state = 'approved'
            AND u.email_verified_at IS NOT NULL AND u.phone_verified_at IS NOT NULL)
            OR (o.active AND o.kind = 'agency'))
`;
