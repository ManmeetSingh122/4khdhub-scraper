export const IMAGE_BASE_URL = "https://image.tmdb.org/t/p/original";
export const SMALL_IMAGE_URL = "https://image.tmdb.org/t/p/w500";

const LOCAL_BACKEND = (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") && window.location.port === "5000"
    ? ""
    : "http://127.0.0.1:5000";
const LOCAL_TMDB_FALLBACK_KEY = "e04a7390c63382a724d5a56b6b7139a8";
const IS_LOCAL_APP = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";

function backendUrl(path) {
    const base = window.NETWATCH_BACKEND || LOCAL_BACKEND;
    return `${base}${path}`;
}

export const endpoints = {
    trendingAll: "/trending/all/week?language=en-US",
    trendingMovies: "/trending/movie/week?language=en-US",
    trendingTV: "/trending/tv/week?language=en-US",
    netwatchOriginals: "/discover/tv?with_networks=213",
    actionMovies: "/discover/movie?with_genres=28",
    comedyMovies: "/discover/movie?with_genres=35",
    scifiMovies: "/discover/movie?with_genres=878",
    horrorMovies: "/discover/movie?with_genres=27",
    animationMovies: "/discover/movie?with_genres=16&include_adult=false",
    romanceMovies: "/discover/movie?with_genres=10749",
    thrillerMovies: "/discover/movie?with_genres=53",
    dramaMovies: "/discover/movie?with_genres=18",
    kidsMovies: "/discover/movie?language=en-US&include_adult=false&certification_country=US&certification.lte=PG&with_genres=16,10751&sort_by=popularity.desc",
    kidsAnimation: "/discover/movie?language=en-US&include_adult=false&certification_country=US&certification.lte=PG&with_genres=16&sort_by=popularity.desc",
    kidsFamily: "/discover/movie?language=en-US&include_adult=false&certification_country=US&certification.lte=PG&with_genres=10751&sort_by=popularity.desc",
    kidsShows: "/discover/tv?language=en-US&include_adult=false&with_genres=10762,16,10751&sort_by=popularity.desc",
    search: "/search/multi?language=en-US&page=1&include_adult=false&query="
};

const genreMap = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Doc",
    18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
    9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 10770: "TV Movie", 53: "Thriller",
    10752: "War", 37: "Western", 10759: "Act/Adv", 10765: "Sci-Fi/Fant", 10768: "War/Pol"
};

export function getGenreNames(genreIds) {
    if (!genreIds || !genreIds.length) return "";
    return genreIds.slice(0, 2).map(id => genreMap[id]).filter(Boolean).join(" / ");
}

export async function fetchTMDB(endpoint) {
    try {
        const response = await fetch(backendUrl(`/api/tmdb?endpoint=${encodeURIComponent(endpoint)}`));
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "TMDB request failed");
        return payload;
    } catch (error) {
        if (IS_LOCAL_APP && /TMDB_API_KEY|Failed to fetch|NetworkError/i.test(error.message || "")) {
            try {
                const separator = endpoint.includes("?") ? "&" : "?";
                const direct = await fetch(`https://api.themoviedb.org/3${endpoint}${separator}api_key=${LOCAL_TMDB_FALLBACK_KEY}`);
                const directPayload = await direct.json();
                if (direct.ok) return directPayload;
            } catch (fallbackError) {
                console.error("Failed to fetch TMDB fallback:", fallbackError);
            }
        }
        console.error("Failed to fetch TMDB data:", error);
        return { results: [], error: error.message };
    }
}
