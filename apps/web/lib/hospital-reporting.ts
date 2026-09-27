export const HOSPITAL_REPORTING_COVERAGE_MIN = 60;
export const HOSPITAL_REPORTING_COVERAGE_MAX = 100;
export function hasUsableHospitalReportingCoverage(value: number | undefined) {
    return value !== undefined && Number.isFinite(value) && value >= HOSPITAL_REPORTING_COVERAGE_MIN && value <= HOSPITAL_REPORTING_COVERAGE_MAX;
}
