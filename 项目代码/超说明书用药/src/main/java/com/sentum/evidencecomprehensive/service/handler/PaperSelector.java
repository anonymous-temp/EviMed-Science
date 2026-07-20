package com.sentum.evidencecomprehensive.service.handler;

import com.sentum.evidencecomprehensive.pojo.bo.es.PaperIndex;

import java.util.*;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/9/8
 */
// 主要的筛选逻辑类
public class PaperSelector {

    private static final int TOTAL_LIMIT = 30;
    private static final int RECENT_YEARS_LIMIT = 20;

    public static List<PaperIndex> selectPapers(List<PaperIndex> paperIndices) {
        // 配置必须纳入的类型及其最少数量
        Map<Integer, Integer> requiredTypeMinCount = new HashMap<>();
        requiredTypeMinCount.put(0, 30);
        requiredTypeMinCount.put(2, 30);
        requiredTypeMinCount.put(3, 30);

        // 优先级顺序
        List<Integer> priorityOrder = Arrays.asList(0, 2, 3);
        // 补充类型的优先级
        List<Integer> supplementTypes = Arrays.asList(4, 5, 7);
        // 结果集合
        List<PaperIndex> result = new ArrayList<>();
        
        Set<PaperIndex> addedPapers = new HashSet<>();

        // 步骤1: 按类型分组，区分近20年和非近20年
        Map<Integer, List<PaperIndex>> recentPapersByType = new HashMap<>();
        Map<Integer, List<PaperIndex>> olderPapersByType = new HashMap<>();
        List<PaperIndex> otherTypePapers = new ArrayList<>();
        List<PaperIndex> supplementTypePapers = new ArrayList<>();

        for (PaperIndex paper : paperIndices) {
            boolean categorized = false;

            // 检查是否包含优先类型 (0, 2, 3)
            for (Integer type : priorityOrder) {
                if (paper.containsType(type)) {
                    if (paper.isRecent20Years()) {
                        recentPapersByType.computeIfAbsent(type, k -> new ArrayList<>()).add(paper);
                    } else {
                        olderPapersByType.computeIfAbsent(type, k -> new ArrayList<>()).add(paper);
                    }
                    categorized = true;
                    break; // 按优先级只归类到第一个匹配的类型
                }
            }

            // 如果不包含优先类型，检查是否包含补充类型
            if (!categorized) {
                boolean isSupplementType = false;
                for (Integer type : supplementTypes) {
                    if (paper.containsType(type)) {
                        supplementTypePapers.add(paper);
                        isSupplementType = true;
                        break;
                    }
                }

                // 其他类型
                if (!isSupplementType) {
                    otherTypePapers.add(paper);
                }
            }
        }

        // 步骤2: 优先从近20年的论文中按权重选择
        Map<Integer, Integer> currentCount = new HashMap<>();

        for (Integer type : priorityOrder) {
            List<PaperIndex> recentPapers = recentPapersByType.getOrDefault(type, new ArrayList<>());
            int required = requiredTypeMinCount.get(type);
            int toAdd = Math.min(required, recentPapers.size());

            for (int i = 0; i < toAdd && result.size() < TOTAL_LIMIT; i++) {
                PaperIndex paper = recentPapers.get(i);
                if (!addedPapers.contains(paper)) {
                    result.add(paper);
                    addedPapers.add(paper);
                    currentCount.put(type, currentCount.getOrDefault(type, 0) + 1);
                }
            }
        }

        // 步骤3: 如果近20年的不够，继续添加近20年的论文（优先级0>2>3）
        for (Integer type : priorityOrder) {
            if (result.size() >= TOTAL_LIMIT) break;

            List<PaperIndex> recentPapers = recentPapersByType.getOrDefault(type, new ArrayList<>());
            int alreadyAdded = currentCount.getOrDefault(type, 0);

            for (int i = alreadyAdded; i < recentPapers.size() && result.size() < TOTAL_LIMIT; i++) {
                PaperIndex paper = recentPapers.get(i);
                if (!addedPapers.contains(paper)) {
                    result.add(paper);
                    addedPapers.add(paper);
                }
            }
        }

        // 步骤4: 如果还不够50篇，从非近20年的论文中补充（按优先级）
        for (Integer type : priorityOrder) {
            if (result.size() >= TOTAL_LIMIT) break;

            List<PaperIndex> olderPapers = olderPapersByType.getOrDefault(type, new ArrayList<>());
            for (PaperIndex paper : olderPapers) {
                if (result.size() >= TOTAL_LIMIT) break;
                if (!addedPapers.contains(paper)) {
                    result.add(paper);
                    addedPapers.add(paper);
                }
            }
        }

        // 步骤5: 如果还不够，从补充类型(4,5,7)中添加
        for (PaperIndex paper : supplementTypePapers) {
            if (result.size() >= TOTAL_LIMIT) break;
            if (!addedPapers.contains(paper)) {
                result.add(paper);
                addedPapers.add(paper);
            }
        }

        // 步骤6: 如果还不够，从其他类型中添加
        for (PaperIndex paper : otherTypePapers) {
            if (result.size() >= TOTAL_LIMIT) break;
            if (!addedPapers.contains(paper)) {
                result.add(paper);
                addedPapers.add(paper);
            }
        }

        // 打印统计信息
        printStatistics(result);

        return result;
    }

    // 统计信息打印方法
    private static void printStatistics(List<PaperIndex> result) {
        Map<Integer, Integer> typeCount = new HashMap<>();
        int recent20YearsCount = 0;

        for (PaperIndex paper : result) {
            if (paper.isRecent20Years()) {
                recent20YearsCount++;
            }

            for (Integer type : paper.getLastNewType()) {
                typeCount.put(type, typeCount.getOrDefault(type, 0) + 1);
            }
        }

        System.out.println("筛选结果统计：");
        System.out.println("总数量: " + result.size());
        System.out.println("近20年论文数量: " + recent20YearsCount);
        System.out.println("各类型分布: ");

        for (Map.Entry<Integer, Integer> entry : typeCount.entrySet()) {
            System.out.println("  类型 " + entry.getKey() + ": " + entry.getValue() + " 篇");
        }
    }
}
