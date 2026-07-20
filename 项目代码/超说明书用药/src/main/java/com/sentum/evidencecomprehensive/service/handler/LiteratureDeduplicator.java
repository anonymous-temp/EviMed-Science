package com.sentum.evidencecomprehensive.service.handler;

import cn.hutool.core.collection.CollUtil;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.pojo.bo.es.PaperIndex;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.MongoLiterature;

import java.util.*;
import java.util.regex.Pattern;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/9/5
 */
public class LiteratureDeduplicator {

    private static final Pattern PUNCTUATION_PATTERN = Pattern.compile("[\\p{Punct}]");

    public static List<MongoLiterature> deduplicateLiteratures(List<PaperIndex> mongoLiteratures, FineScreenFeign fineScreenFeign) {
        if (CollUtil.isEmpty(mongoLiteratures)) {
            return new ArrayList<>();
        }

        Map<String, MongoLiterature> deduplicatedMap = new LinkedHashMap<>();
        List<String> processedTitles = new ArrayList<>();

        for (PaperIndex paperIndex : mongoLiteratures) {
            String id = paperIndex.getId();
            MongoLiterature literature = fineScreenFeign.paper(id);
            if (literature != null) {
                String originalTitle = literature.getTitle();
                String cleanedTitle = cleanTitle(originalTitle);

                if (!processedTitles.contains(cleanedTitle)) {
                    deduplicatedMap.put(cleanedTitle, literature);
                    processedTitles.add(cleanedTitle);
                } else {
                    MongoLiterature existing = deduplicatedMap.get(cleanedTitle);
                    if (compareLiteratures(existing, literature)) {
                        deduplicatedMap.put(cleanedTitle, literature);
                    }
                } 
            }
        }

        // 相似度比较
        List<MongoLiterature> resultList = new ArrayList<>(deduplicatedMap.values());
        int size = resultList.size();
        for (int i = 0; i < size; i++) {
            for (int j = i + 1; j < size; j++) {
                MongoLiterature lit1 = resultList.get(i);
                MongoLiterature lit2 = resultList.get(j);
                String title1 = cleanTitle(lit1.getTitle());
                String title2 = cleanTitle(lit2.getTitle());

                if (calculateSimilarity(title1, title2) >= 0.9) {
                    if (compareLiteratures(lit1, lit2)) {
                        resultList.remove(j);
                        j--;
                        size--;
                    } else {
                        resultList.remove(i);
                        i--;
                        size--;
                        break;
                    }
                }
            }
        }

        return resultList;
    }

    private static String cleanTitle(String title) {
        if (title == null) return "";
        String noPunctuation = PUNCTUATION_PATTERN.matcher(title).replaceAll("");
        return noPunctuation.trim().toLowerCase();
    }

    private static boolean compareLiteratures(MongoLiterature existing, MongoLiterature candidate) {
        int yearCompare = Integer.compare(parseInt(candidate.getYear()), parseInt(existing.getYear()));
        if (yearCompare > 0) {
            return true;
        } else if (yearCompare < 0) {
            return false;
        }
//        else {
//            // Year is the same, check author
//            return !candidate.getAuthor().isEmpty() && existing.getAuthor().isEmpty();
//        }

        // 年份相同时，比较四个字段的完整性（选择信息最全的）
        int candidateCompleteness = countCompleteFields(candidate);
        int existingCompleteness = countCompleteFields(existing);

        return candidateCompleteness > existingCompleteness;
    }

    /**
     * 统计四个关键字段中有值的数量
     * @return 有值的字段数量（0-4）
     */
    private static int countCompleteFields(MongoLiterature literature) {
        int count = 0;

        // 1. 检查影响因子是否有值
        if (literature.getJcr() != null && literature.getJcr() > 0) {
            count++;
        }

        // 2. 检查期刊分区是否有值
        if (literature.getJournalDivision() != null && !literature.getJournalDivision().isEmpty()) {
            count++;
        }

        // 3. 检查核心期刊是否有值
        if (literature.getRecognizedKernelJournals() != null && !literature.getRecognizedKernelJournals().isEmpty()) {
            count++;
        }

        // 4. 检查作者是否有值
        if (literature.getAuthor() != null && !literature.getAuthor().isEmpty()) {
            count++;
        }

        return count;
    }


    private static int parseInt(String year) {
        try {
            return Integer.parseInt(year);
        } catch (NumberFormatException e) {
            return 0; // or handle it in a way that suits your application
        }
    }

    private static double calculateSimilarity(String s1, String s2) {
        if (s1.equals(s2)) {
            return 1.0;
        }
        if (s1.length() == 0 || s2.length() == 0) {
            return 0.0;
        }

        int[][] dp = new int[s1.length() + 1][s2.length() + 1];

        for (int i = 0; i <= s1.length(); i++) {
            for (int j = 0; j <= s2.length(); j++) {
                if (i == 0 || j == 0) {
                    dp[i][j] = 0;
                } else if (s1.charAt(i - 1) == s2.charAt(j - 1)) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        int lcs = dp[s1.length()][s2.length()];
        double similarity = (2.0 * lcs) / (s1.length() + s2.length());
        return similarity;
    }
}
