-- true = sponsors work visas, false = explicitly doesn't, NULL = not mentioned.
ALTER TABLE job_postings ADD COLUMN visa_sponsorship boolean;
