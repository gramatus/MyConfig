; extends
(region_directive (preproc_message) @region.message)
(member_access_expression expression: (identifier) @initialIdentifier)
(member_access_expression name: (identifier) @property.access)
(invocation_expression (member_access_expression name: (identifier) @property.method.call))
(initializer_expression (assignment_expression left: (identifier) @initializer.property))
