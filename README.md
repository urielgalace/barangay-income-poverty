# Barangay Income and Poverty Atlas

**Website: https://urielgalace.github.io/barangay-income-poverty/**

A dataset covering all 42,010 barangays in the Philippines. Official government data are used for income and poverty rates at the regional and provincial levels, while machine learning is used to estimate data at the barangay level. All barangay estimates are preliminary.

Barangay and municipal figures are estimates. A typical barangay's 90% interval is about 32 percentage points wide, indicating a substantial error margin, so they should be used with caution.

## On the site

- [Map](https://urielgalace.github.io/barangay-income-poverty/map.html): Explore income and poverty estimates for every barangay, including margins of error and shareable links.
- [Trends](https://urielgalace.github.io/barangay-income-poverty/trends.html): Examine official income and poverty trends from 2018 to 2025 across different geographic areas.
- [Statistics](https://urielgalace.github.io/barangay-income-poverty/statistics.html): Explore population distributions, the geographic concentration of poverty, and detailed statistical tables.
- [Calculator](https://urielgalace.github.io/barangay-income-poverty/calculator.html): Enter your income to see how it compares with others, determine what income class you belong to, and assess how your income compares with the living wage.
- [Methodology](https://urielgalace.github.io/barangay-income-poverty/methodology.html): Learn how the estimates were constructed, including the data sources and machine learning models.
- [Version History](https://urielgalace.github.io/barangay-income-poverty/versions.html): Review the current version of the dataset and the data behind it.
- [About](https://urielgalace.github.io/barangay-income-poverty/about.html): Find answers to frequently asked questions and information on how to report potential errors.

## This repository

- `docs/` is the site served by GitHub Pages.
- `website/` contains the templates, styles, scripts and build steps.

Raw source files are not republished here. The methodology page lists these, with its source and checksum.

## Citation and terms

See `CITATION.cff`. No open license has been chosen yet. You are welcome to view and cite the data. Please ask before redistributing it.

Official data are from the Philippine Statistics Authority.

## Report a problem

[Open an issue](https://github.com/urielgalace/barangay-income-poverty/issues/new?template=data-problem.yml) to report potential errors.
