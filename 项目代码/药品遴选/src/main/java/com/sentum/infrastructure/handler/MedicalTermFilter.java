package com.sentum.infrastructure.handler;

import java.util.*;
import java.util.regex.Pattern;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/8/12
 */
public class MedicalTermFilter {

    // 定义需要删除的介词
    private static final Set<String> PREPOSITIONS = new HashSet<>();

    // 定义需要删除的连接词
    private static final Set<String> CONJUNCTIONS = new HashSet<>();

    // 定义需要删除的其他功能词
    private static final Set<String> FUNCTION_WORDS = new HashSet<>();

    // 定义所有需要删除的词汇
    private static final Set<String> WORDS_TO_REMOVE = new HashSet<>();

    // 中文标点符号正则表达式
    private static final Pattern CHINESE_PUNCTUATION = Pattern.compile("[\\u3000-\\u303F\\uFF00-\\uFFEF\\u2000-\\u206F\\u2E00-\\u2E7F\\p{P}]");

    // 判断是否为中文字符的正则表达式
    private static final Pattern CHINESE_CHAR = Pattern.compile("[\\u4e00-\\u9fff]");



    static {
        // 介词
        PREPOSITIONS.addAll(Arrays.asList(
                "to", "in", "on", "at", "by", "for", "with", "without", "of", "from",
                "into", "onto", "upon", "over", "under", "above", "below", "through",
                "across", "along", "around", "between", "among", "during", "before",
                "after", "since", "until", "within", "against", "toward", "towards"
        ));

        // 连接词
        CONJUNCTIONS.addAll(Arrays.asList(
                "and", "or", "but", "nor", "for", "so", "yet", "either", "neither",
                "both", "not", "however", "therefore", "moreover", "furthermore",
                "nevertheless", "nonetheless", "meanwhile", "otherwise", "thus", "hence"
        ));

        // 其他功能词（冠词、助动词、代词等）
        FUNCTION_WORDS.addAll(Arrays.asList(
                "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
                "have", "has", "had", "do", "does", "did", "will", "would", "could",
                "should", "may", "might", "can", "must", "shall", "this", "that",
                "these", "those", "i", "you", "he", "she", "it", "we", "they",
                "me", "him", "her", "us", "them", "my", "your", "his", "hers",
                "its", "our", "their", "myself", "yourself", "himself", "herself",
                "itself", "ourselves", "yourselves", "themselves"
        ));

        // 合并所有需要删除的词汇
        WORDS_TO_REMOVE.addAll(PREPOSITIONS);
        WORDS_TO_REMOVE.addAll(CONJUNCTIONS);
        WORDS_TO_REMOVE.addAll(FUNCTION_WORDS);
    }

    /**
     * 判断字符串是否包含中文字符
     */
    private static boolean containsChinese(String text) {
        return CHINESE_CHAR.matcher(text).find();
    }

    /**
     * 处理中文文本，去除标点符号
     */
    private static String processChinese(String input) {
        if (input == null || input.trim().isEmpty()) {
            return "";
        }

        // 去除所有标点符号（包括中文和英文标点）
        String cleanText = CHINESE_PUNCTUATION.matcher(input).replaceAll("");

        // 去除多余的空格
        cleanText = cleanText.replaceAll("\\s+", " ").trim();

        return cleanText;
    }

    /**
     * 过滤掉介词、连接词等功能词，只保留有语义的关键词
     * @param input 输入的字符串
     * @return 过滤后的字符串，只包含有语义的词汇
     */
    public static String filterSemanticWords(String input) {
        if (input == null || input.trim().isEmpty()) {
            return "";
        }

        // 如果包含中文，使用中文处理逻辑
        if (containsChinese(input)) {
            String cleanText = CHINESE_PUNCTUATION.matcher(input).replaceAll("");
            return cleanText.replaceAll("\\s+", " ").trim();
        }

        // 转换为小写并分割单词
        String[] words = input.toLowerCase().trim().split("\\s+");
        List<String> semanticWords = new ArrayList<>();

        for (String word : words) {
            // 移除标点符号
            String cleanWord = word.replaceAll("[^a-zA-Z0-9]", "");

            // 跳过空字符串
            if (cleanWord.isEmpty()) {
                continue;
            }

//            // 跳过数字（可选，根据需求调整）
//            if (isNumeric(cleanWord)) {
//                continue;
//            }

            // 跳过单个字符的词（通常是缩写或无意义词）
            if (cleanWord.length() <= 1) {
                continue;
            }

            // 如果不在删除列表中，则保留
            if (!WORDS_TO_REMOVE.contains(cleanWord)) {
                semanticWords.add(cleanWord);
            }
        }

        return String.join(" ", semanticWords);
    }

    /**
     * 高级过滤方法，提供更多选项
     * @param input 输入的字符串
     * @param options 过滤选项
     * @return 过滤后的字符串
     */
    public static String filterSemanticWords(String input, FilterOptions options) {
        if (input == null || input.trim().isEmpty()) {
            return "";
        }

        // 如果包含中文，使用中文处理逻辑
        if (containsChinese(input)) {
            String cleanText = CHINESE_PUNCTUATION.matcher(input).replaceAll("");
            return cleanText.replaceAll("\\s+", " ").trim();
        }

        // 英文处理逻辑
        String[] words = input.toLowerCase().trim().split("\\s+");
        List<String> semanticWords = new ArrayList<>();

        for (String word : words) {
            // 移除标点符号
            String cleanWord = word.replaceAll("[^a-zA-Z0-9]", "");

            if (cleanWord.isEmpty()) {
                continue;
            }

            // 根据选项处理数字
            if (!options.keepNumbers && isNumeric(cleanWord)) {
                continue;
            }

            // 根据选项处理短词
            if (cleanWord.length() <= options.minWordLength) {
                continue;
            }

            // 检查是否在删除列表中
            boolean shouldRemove = false;

            if (options.removePrepositions && PREPOSITIONS.contains(cleanWord)) {
                shouldRemove = true;
            }
            if (options.removeConjunctions && CONJUNCTIONS.contains(cleanWord)) {
                shouldRemove = true;
            }
            if (options.removeFunctionWords && FUNCTION_WORDS.contains(cleanWord)) {
                shouldRemove = true;
            }

            // 检查自定义删除列表
            if (options.customWordsToRemove != null &&
                    options.customWordsToRemove.contains(cleanWord)) {
                shouldRemove = true;
            }

            if (!shouldRemove) {
                semanticWords.add(cleanWord);
            }
        }

        return String.join(" ", semanticWords);
    }

    /**
     * 专门用于医学术语的过滤方法
     * @param input 输入的医学术语字符串
     * @return 过滤后只包含医学关键词的字符串
     */
    public static String filterMedicalTerms(String input) {
        if (input == null || input.trim().isEmpty()) {
            return "";
        }

        // 如果包含中文，直接去除标点符号
        if (containsChinese(input)) {
            return processChinese(input);
        }

        // 英文医学术语处理
        FilterOptions options = new FilterOptions();
        options.removePrepositions = true;
        options.removeConjunctions = true;
        options.removeFunctionWords = true;
        options.keepNumbers = false;  // 医学术语中通常不需要保留数字
        options.minWordLength = 2;    // 保留长度大于2的词

        // 添加一些医学相关的功能词到删除列表
        options.customWordsToRemove = new HashSet<>(Arrays.asList(
                "with", "without", "mild", "moderate", "severe", "acute", "chronic",
                "primary", "secondary", "stage", "grade",
//                "type", 
                "form", "case",
                "patient", "condition", "disease", "syndrome", "disorder"
        ));

        return filterSemanticWords(input, options);
    }

    /**
     * 过滤选项配置类
     */
    public static class FilterOptions {
        public boolean removePrepositions = true;
        public boolean removeConjunctions = true;
        public boolean removeFunctionWords = true;
        public boolean keepNumbers = false;
        public int minWordLength = 1;
        public Set<String> customWordsToRemove = null;

        public FilterOptions() {}
    }

    /**
     * 检查字符串是否为数字
     */
    private static boolean isNumeric(String str) {
        if (str == null || str.isEmpty()) {
            return false;
        }
        try {
            Double.parseDouble(str);
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /**
     * 获取被过滤掉的词汇（用于调试）
     * @param input 输入字符串
     * @return 被过滤掉的词汇列表
     */
    public static List<String> getFilteredWords(String input) {
        if (input == null || input.trim().isEmpty()) {
            return new ArrayList<>();
        }

        // 如果包含中文，返回被过滤掉的标点符号
        if (containsChinese(input)) {
            List<String> filteredChars = new ArrayList<>();
            String filtered = CHINESE_PUNCTUATION.matcher(input).replaceAll("");
            if (!input.equals(filtered)) {
                filteredChars.add("标点符号已被移除");
            }
            return filteredChars;
        }

        // 英文词汇过滤
        String[] words = input.toLowerCase().trim().split("\\s+");
        List<String> filteredWords = new ArrayList<>();

        for (String word : words) {
            String cleanWord = word.replaceAll("[^a-zA-Z0-9]", "");

            if (!cleanWord.isEmpty() && WORDS_TO_REMOVE.contains(cleanWord)) {
                filteredWords.add(cleanWord);
            }
        }

        return filteredWords;
    }

    // 测试方法
    public static void main(String[] args) {
        // 测试用例
        String[] testCases = {
                "moderate to severe active ulcerative colitis",
                "patient with chronic inflammatory bowel disease",
                "急性和严重的腹部疼痛",
                "慢性炎症性肠病的诊断，伴有活动性炎症。",
                "中重度活动性溃疡性结肠炎！",
                "治疗严重的活动性结肠炎？",
                "inflammatory bowel disease not otherwise specified",
                "混合测试：moderate 急性炎症 with 慢性疾病, chronic condition！"
        };

        System.out.println("=== 基础语义词过滤测试 ===");
        for (String testCase : testCases) {
            String filtered = filterSemanticWords(testCase);
            List<String> removedWords = getFilteredWords(testCase);

            System.out.println("原文: " + testCase);
            System.out.println("保留: " + filtered);
            System.out.println("删除: " + removedWords);
            System.out.println("---");
        }

        System.out.println("\n=== 医学术语特定过滤测试 ===");
        for (String testCase : testCases) {
            String filtered = filterMedicalTerms(testCase);

            System.out.println("原文: " + testCase);
            System.out.println("医学关键词: " + filtered);
            System.out.println("---");
        }
    }
}