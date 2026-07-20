package com.sentum.evidencecomprehensive.opcode;

import cn.hutool.core.util.StrUtil;
import com.codeinchinese.英汉词典.英汉词典;
import com.codeinchinese.英汉词典.词形变化;
import com.codeinchinese.英汉词典.词条;
import com.sentum.evidencecomprehensive.pojo.enums.GuideQueryEnum;
import com.sentum.evidencecomprehensive.pojo.enums.PaperQueryEnum;
import com.sentum.evidencecomprehensive.service.handler.MedicalTermFilter;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.index.query.*;
import org.elasticsearch.index.query.functionscore.ScriptScoreFunctionBuilder;
import org.elasticsearch.script.Script;
import org.elasticsearch.script.ScriptType;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.*;

import static com.sentum.evidencecomprehensive.utils.GetMaxSimilarUtil.judgeChinese;

@Slf4j
@Component
public class FormulaUtil {

    /**
     * 创建检索的query
     *
     * @param range  检索范围
     * @param words  检索词
     * @param type   1-文献；2-指南；3-说明书
     * @param status true，A OR B OR C OR ...
     * @param opType 1-OR；2-AND；3-NOT
     * @param level
     * @return 单次拼接后的query
     */
    public static QueryBuilder createQueryBuilder(String range, String words, int type, boolean status, int opType, int isPhrase, int level) {
        if (StrUtil.isBlank(words)) {
            throw new RuntimeException("检索式格式错误");
        }
        if (type == 1) {
            //文献
            return buildPaperQueryBuilder(range, words, status, opType, isPhrase, level);
        } else if (type == 2) {
            //指南
            return buildGuideQueryBuilder(range, words, status, opType, level);
//            return buildGuideQueryBuilder(range, words, status, opType);
        } else if (type == 3){
            //说明书
            return buildInstructionQueryBuilder(range, words, status, opType);
        }
        else if (type == 4){
            //临床试验
            return buildClinicalTrialsQueryBuilder(range, words, status, opType);
        } 
        return null;
    }

    /**
     * 拼接文献检索条件
     *
     * @param range  检索范围
     * @param words  检索词
     * @param status true，A OR B OR C OR ...
     * @param opType 1-OR；2-AND；3-NOT
     * @param level
     * @return 单次拼接后的query
     */
    private static QueryBuilder buildPaperQueryBuilder(String range, String words, boolean status, int opType, Integer isPhrase, int level){
        try {
            // 解析检索词
            List<String> retrievalTerms = new ArrayList<>();
            if (status) {
                retrievalTerms.addAll(Arrays.asList(words.split("\\|")));
            } else {
                retrievalTerms.add(words);
            }

            BoolQueryBuilder mainQuery = QueryBuilders.boolQuery();
            DisMaxQueryBuilder synonymGroupDisMax = QueryBuilders.disMaxQuery();

            for (String term : retrievalTerms) {
                String processedWord = MedicalTermFilter.filterSemanticWords(term.toLowerCase());

                if (StringUtils.isBlank(processedWord)) {
                    continue;
                }

                QueryBuilder termQuery;

                // 处理通配符查询
                if ((processedWord.contains("*") || processedWord.contains("?")) && processedWord.length() > 4) {
                    termQuery = buildPaperWildCardQueryBuilder(range, processedWord, isPhrase);
                }
                // 处理范围查询
                else if ("年份".equals(range) || "影响因子".equals(range)) {
                    String[] timeRange = processedWord.split("[:：]");
                    if (timeRange.length != 2) {
                        throw new IllegalArgumentException("范围查询格式错误");
                    }
                    String fieldName = "年份".equals(range) ? "year" : "jcr";
                    termQuery = QueryBuilders.rangeQuery(fieldName)
                            .gte(timeRange[0].trim())
                            .lte(timeRange[1].trim());
                }
                // 处理特定字段查询
                else if (StringUtils.isNotEmpty(range)) {
                    BoolQueryBuilder fieldQuery = QueryBuilders.boolQuery();
                    MultiMatchQueryBuilder multiMatchQuery = null;

                    switch (range) {
                        case "标题":
                        case "主题":
                            multiMatchQuery = QueryBuilders.multiMatchQuery(processedWord, "title");
                            break;

                        case "摘要":
                            multiMatchQuery = QueryBuilders.multiMatchQuery(processedWord, "summary");
                            break;

                        case "关键词":
                            fieldQuery.should().add(QueryBuilders.termQuery("keywords", processedWord));
                            break;

                        case "题关摘":
                            multiMatchQuery = QueryBuilders.multiMatchQuery(processedWord, "summary", "title")
                                    .field("title", 100f);
                            fieldQuery.should().add(QueryBuilders.termQuery("keywords", processedWord));
                            break;

                        case "作者":
                            fieldQuery.should().add(QueryBuilders.matchPhraseQuery("author", processedWord));
                            break;

                        case "全部":
                            multiMatchQuery = QueryBuilders.multiMatchQuery(processedWord, "title", "summary", "tldr", "result", "conclusion")
                                    .field("title", 100f)
                                    .field("keywords", 10f);
                            fieldQuery.should().add(QueryBuilders.matchPhraseQuery("author", processedWord));
                            fieldQuery.should().add(QueryBuilders.matchPhraseQuery("journal", processedWord));
                            fieldQuery.should().add(QueryBuilders.termQuery("keywords", processedWord));
                            break;

                        case "期刊":
                            fieldQuery.should(QueryBuilders.matchPhraseQuery("journal", processedWord));
                            break;

                        case "机构":
                            fieldQuery.should().add(QueryBuilders.matchPhraseQuery("showAuthorAddress", processedWord));
                            break;

                        case "DOI":
                            fieldQuery.should().add(QueryBuilders.termQuery("doi", processedWord.toLowerCase()));
                            break;

                        case "精筛":
                            multiMatchQuery = QueryBuilders.multiMatchQuery(processedWord, "title", "titleQuestion", "tldr", "result", "conclusion")
                                    .field("title", 100f)
                                    .field("titleQuestion", 5f)
                                    .field("tldr", 1f);
                            fieldQuery.should().add(QueryBuilders.termQuery("keywords", processedWord));
                            break;

                        case "初筛":
                            multiMatchQuery = QueryBuilders.multiMatchQuery(processedWord, "title", "titleQuestion", "tldr", "summary", "result", "conclusion", "author", "journal")
                                    .field("title", 100f)
                                    .field("titleQuestion", 5f)
                                    .field("tldr", 1f)
                                    .field("summary", 0.5f);
                            fieldQuery.should().add(QueryBuilders.termQuery("keywords", processedWord));
                            break;

                        default:
                            multiMatchQuery = QueryBuilders.multiMatchQuery(processedWord, "title");
                            break;
                    }

                    if (multiMatchQuery != null) {
                        multiMatchQuery.operator(Operator.AND)
                                .type(MultiMatchQueryBuilder.Type.PHRASE);
//                                .analyzer("standard");

                        if (isPhrase == 0 && processedWord.matches(".*[\\u4e00-\\u9fa5].*")) {
                            multiMatchQuery.type(MultiMatchQueryBuilder.Type.PHRASE);
                        }
                        fieldQuery.should().add(multiMatchQuery);
                    }

                    // 添加年份调整的 function_score 查询
                    termQuery = adjustScoreByYear(fieldQuery);

                    synonymGroupDisMax.add(termQuery);
                } else {
                    boolean isChinese = processedWord.matches(".*[\\u4e00-\\u9fa5].*");
                    PaperQueryEnum paperQueryEnum = PaperQueryEnum.of(level);

                    DisMaxQueryBuilder wordDisMaxQuery = QueryBuilders.disMaxQuery();

                    float boost = isChinese ? paperQueryEnum.getZhPhraseBoost() : paperQueryEnum.getPhraseBoost();
                    MultiMatchQueryBuilder phraseQuery = QueryBuilders.multiMatchQuery(processedWord, "title", "summary", "tldr", "result", "conclusion")
                            .field("title", paperQueryEnum.getTitleBoost())
                            .field("summary", paperQueryEnum.getSummaryBoost())
                            .field("tldr", paperQueryEnum.getTldrBoost())
                            .field("result", paperQueryEnum.getResultBoost())
                            .field("conclusion", paperQueryEnum.getConclusionBoost())
                            .type(MultiMatchQueryBuilder.Type.PHRASE)
                            .analyzer("ik_smart")
                            .operator(Operator.AND)
                            .boost(boost);
                    wordDisMaxQuery.add(phraseQuery);

                    TermQueryBuilder keywordQuery = QueryBuilders.termQuery("keywords", processedWord)
                            .boost(paperQueryEnum.getKeywordBoost() * 10);
                    wordDisMaxQuery.add(keywordQuery);

//                    if (!isChinese) {
//                        MultiMatchQueryBuilder bestFieldsQuery = QueryBuilders.multiMatchQuery(processedWord, "title", "summary", "tldr", "result", "conclusion", "allKeyword")
//                                .field("title", paperQueryEnum.getTitleBoost())
//                                .field("summary", paperQueryEnum.getSummaryBoost())
//                                .field("keywords", paperQueryEnum.getKeywordBoost())
//                                .field("tldr", paperQueryEnum.getTldrBoost())
//                                .field("result", paperQueryEnum.getResultBoost())
//                                .field("conclusion", paperQueryEnum.getConclusionBoost())
//                                .type(MultiMatchQueryBuilder.Type.BEST_FIELDS)
//                                .operator(Operator.AND)
////                                .analyzer("standard")
//                                .boost(paperQueryEnum.getBestBoost());
//                        wordDisMaxQuery.add(bestFieldsQuery);
//                    }
                    // 添加年份调整的 function_score 查询
                    termQuery = adjustScoreByYear(wordDisMaxQuery);

                    synonymGroupDisMax.add(termQuery);
                }
            }

            switch (opType) {
                case 1: // OR
                    mainQuery.should().add(synonymGroupDisMax);
                    break;
                case 2: // AND
                    mainQuery.must().add(synonymGroupDisMax);
                    break;
                case 3: // NOT
                    mainQuery.mustNot().add(synonymGroupDisMax);
                    break;
                default:
                    mainQuery.should().add(synonymGroupDisMax);
            }

            return mainQuery;

        } catch (Exception e) {
            log.error(e.getMessage(), e);
            throw new RuntimeException("检索式格式错误");
        }
    }

    private static QueryBuilder adjustScoreByYear(QueryBuilder baseQuery) {
        LocalDate currentDate = LocalDate.now();
        int currentYear = currentDate.getYear();

        // 创建 Script 对象
        Script script = new Script(ScriptType.INLINE, "painless",
                "if (params.doc['year'].size() > 0) {" +
                        "    def yearStr = params.doc['year'].value;" +
                        "    if (yearStr =~ /\\d{4}/) {" +
                        "        def yearParsed = Integer.parseInt(yearStr);" +
                        "        def yearsAgo = params.currentYear - yearParsed;" +
                        "        if (yearsAgo < 5) { return params.weight1; }" +
                        "        else if (yearsAgo < 10) { return params.weight2; }" +
                        "        else if (yearsAgo < 15) { return params.weight3; }" +
                        "    }" +
                        "}" +
                        "return 0.1;", // 默认权重为 0.1
                createScriptParams(currentYear)
        );

        // 创建 ScriptScoreFunctionBuilder
        ScriptScoreFunctionBuilder scriptScoreFunction = new ScriptScoreFunctionBuilder(script);

        // 创建 FunctionScoreQueryBuilder 并添加 ScriptScoreFunctionBuilder
        return QueryBuilders.functionScoreQuery(
                baseQuery,
                scriptScoreFunction
        );
    }

    /**
     * 拼接指南检索条件
     *
     * @param words  检索词
     * @param status true，A OR B OR C OR ...
     * @param opType 1-OR；2-AND；3-NOT
     * @return 单次拼接后的query
     */
//    private static QueryBuilder buildGuideQueryBuilder(String range, String words, boolean status, int opType){
//        List<String> retrieval = new ArrayList<>();
//        if (status){
//            //相同操作符拼接的检索条件
//            String[] split = words.split("\\|");
//            retrieval.addAll(Arrays.asList(split));
//        }else {
//            retrieval.add(words);
//        }
//        try {
//            BoolQueryBuilder endBool = QueryBuilders.boolQuery();
//            for (String cond : retrieval) {
//                cond = cond.toLowerCase();
//                BoolQueryBuilder ans = QueryBuilders.boolQuery();
//                MultiMatchQueryBuilder condition = null;
//                QueryBuilder rangeCondition = null;
//                MatchPhraseQueryBuilder blockPhraseQuery = null;
//                if (StringUtils.isNotBlank(range)){
//                    if (StrUtil.equals("标题", range) || StrUtil.equals("主题", range)) {
//                        condition = QueryBuilders.multiMatchQuery(cond, "title");
//                    } else if (StrUtil.equals("摘要", range)) {
//                        condition = QueryBuilders.multiMatchQuery(cond, "nrjs");
//                    } else if (StrUtil.equals("关键词", range)) {
//                        ans.should().add(QueryBuilders.termQuery("keywords", cond));
//                    } else if (StrUtil.equals("题关摘", range)) {
//                        condition = QueryBuilders.multiMatchQuery(cond ,"nrjs","title");
//                        condition.field("title",100f);
//                        ans.should().add(QueryBuilders.termQuery("keywords", cond));
//                    } else if (StrUtil.equals("制定者", range)) {
//                        ans.should().add(QueryBuilders.matchPhraseQuery("zdz", cond));
//                    } else if (StrUtil.equals("全部", range)) {
//                        condition = QueryBuilders.multiMatchQuery(cond, "title", "nrjs", "questionAnswer", "pdf_txt");
//                        ans.should().add(QueryBuilders.matchPhraseQuery("zdz", cond));
//                        ans.should().add(QueryBuilders.termQuery("keywords", cond));
//                        condition.field("title",100f);
//                        condition.field("nrjs", 0.1f);
//                        condition.field("pdf_txt", 0.01f   );
//                    } else if (StrUtil.equals("年份", range)) {
//                        String[] timeRange = cond.split("[:：]");
//                        rangeCondition = QueryBuilders.rangeQuery("ysar").gte(timeRange[0].trim()).lte(timeRange[1].trim());
//                    } else if (StrUtil.equals("block", range)) {
//                        blockPhraseQuery = QueryBuilders.matchPhraseQuery("block", cond);
//                    }
//                }else {
//                    condition = QueryBuilders.multiMatchQuery(cond, "title", "nrjs", "questionAnswer", "pdf_txt");
//                    condition.operator(Operator.AND);
//                    condition.field("title", 100f);
//                    condition.field("nrjs", 0.1f);
//                    condition.field("pdf_txt", 0.01f);
//                    condition.type(MultiMatchQueryBuilder.Type.PHRASE);
//                    ans.should().add(condition);
//                    ans.should().add(QueryBuilders.termQuery("keywords", cond));
//                }
//                if (condition != null) {
//                    condition.operator(Operator.AND);
//                    condition.type(MultiMatchQueryBuilder.Type.PHRASE);
//                    condition.analyzer("standard");
//                    ans.should().add(condition);
//                } else if (rangeCondition != null) {
//                    ans.should().add(rangeCondition);
//                } else if (blockPhraseQuery != null) {
//                    ans.should().add(blockPhraseQuery);
//                }
//                if (opType == 1){
//                    //OR
//                    endBool.should().add(ans);
//                }else if (opType == 2){
//                    //AND
//                    endBool.must().add(ans);
//                }else {
//                    //NOT
//                    return ans;
//                }
//            }
//            return endBool;
//        } catch (Exception e) {
//            log.error(e.getMessage(), e);
//            throw new RuntimeException("检索式格式错误");
//        }
//    }

    private static QueryBuilder buildGuideQueryBuilder(String range, String words, boolean status, int opType, int level){
        List<String> retrieval = new ArrayList<>();

        if (status){
            // 相同操作符拼接的检索条件
            String[] split = words.split("\\|");
            retrieval.addAll(Arrays.asList(split));
        } else {
            retrieval.add(words);
        }

        try {
            DisMaxQueryBuilder synonymGroupDisMax = QueryBuilders.disMaxQuery();
            BoolQueryBuilder endBool = QueryBuilders.boolQuery();

            for (String cond : retrieval) {
                String word = cond.toLowerCase();
                // 祛除一些词
                word = MedicalTermFilter.filterSemanticWords(word);

                if (StringUtils.isBlank(word)) {
                    continue; // 跳过空词
                }

                QueryBuilder finalQuery = null;

                if (StringUtils.isNotBlank(range)) {
                    // 处理指定范围的查询
                    BoolQueryBuilder rangeBasedQuery = QueryBuilders.boolQuery();

                    switch (range) {
                        case "标题":
                        case "主题":
                            MultiMatchQueryBuilder titleQuery = QueryBuilders.multiMatchQuery(cond, "title")
                                    .operator(Operator.AND).type(MultiMatchQueryBuilder.Type.PHRASE);
//                                    .analyzer("standard");
                            rangeBasedQuery.should().add(titleQuery);
                            break;

                        case "摘要":
                            MultiMatchQueryBuilder abstractQuery = QueryBuilders.multiMatchQuery(cond, "nrjs")
                                    .operator(Operator.AND).type(MultiMatchQueryBuilder.Type.PHRASE);
//                                    .analyzer("standard");
                            rangeBasedQuery.should().add(abstractQuery);
                            break;

                        case "关键词":
                            rangeBasedQuery.should().add(QueryBuilders.termQuery("keywords", cond));
                            break;

                        case "题关摘":
                            MultiMatchQueryBuilder titleAbstractQuery = QueryBuilders.multiMatchQuery(cond, "nrjs", "title")
                                    .field("title", 100f).operator(Operator.AND).type(MultiMatchQueryBuilder.Type.PHRASE);
//                                    .analyzer("standard");
                            rangeBasedQuery.should().add(titleAbstractQuery);
                            rangeBasedQuery.should().add(QueryBuilders.termQuery("keywords", cond));
                            break;

                        case "制定者":
                            rangeBasedQuery.should().add(QueryBuilders.matchPhraseQuery("zdz", cond));
                            break;

                        case "全部":
                            MultiMatchQueryBuilder allFieldsQuery = QueryBuilders.multiMatchQuery(cond, "title", "nrjs", "questionAnswer", "pdf_txt")
                                    .field("title", 100f).field("nrjs", 0.1f).field("pdf_txt", 0.01f)
                                    .operator(Operator.AND).type(MultiMatchQueryBuilder.Type.PHRASE);
//                                    .analyzer("standard");
                            rangeBasedQuery.should().add(allFieldsQuery);
                            rangeBasedQuery.should().add(QueryBuilders.matchPhraseQuery("zdz", cond));
                            rangeBasedQuery.should().add(QueryBuilders.termQuery("keywords", cond));
                            break;

                        case "年份":
                            String[] timeRange = cond.split("[:：]");
                            if (timeRange.length == 2) {
                                QueryBuilder rangeCondition = QueryBuilders.rangeQuery("ysar").gte(timeRange[0].trim()).lte(timeRange[1].trim());
                                rangeBasedQuery.should().add(rangeCondition);
                            } else {
                                throw new IllegalArgumentException("年份范围格式错误，应为 '开始年份:结束年份'");
                            }
                            break;

                        case "block":
                            rangeBasedQuery.should().add(QueryBuilders.matchPhraseQuery("block", cond));
                            break;

                        default:
                            throw new IllegalArgumentException("不支持的检索范围: " + range);
                    }
                    finalQuery = rangeBasedQuery;

                    synonymGroupDisMax.add(finalQuery);
                } else {
                    // 处理通用查询（无指定范围）
                    boolean chinese = judgeChinese(word);
//                    GuideQueryEnum guideQueryEnum = GuideQueryEnum.of(level);
                    DisMaxQueryBuilder wordDisMaxQuery = QueryBuilders.disMaxQuery();

                    // 1. 精确短语匹配
                    MultiMatchQueryBuilder phraseQuery = QueryBuilders.multiMatchQuery(word, "title", "nrjs", "pdf_txt")
                            .field("title", 1000f)
                            .field("nrjs", 0.5f)
                            .field("pdf_txt", 10f)
                            .type(MultiMatchQueryBuilder.Type.PHRASE)
                            .analyzer("ik_smart")
                            .boost(chinese ? 8f : 10f);
                    wordDisMaxQuery.add(phraseQuery);

//                    // 3. 最佳字段匹配（仅对非中文）
//                    if (!chinese) {
//                        MultiMatchQueryBuilder bestFieldsQuery = QueryBuilders.multiMatchQuery(word, "title", "nrjs", "pdf_txt")
//                                .field("title", 1000f)
//                                .field("nrjs", 0.5f)
//                                .field("pdf_txt", 10f)
//                                .type(MultiMatchQueryBuilder.Type.BEST_FIELDS)
//                                .operator(Operator.AND)
////                                .analyzer("standard")
//                                .slop(10)
//                                .boost(8f);
//                        wordDisMaxQuery.add(bestFieldsQuery);
//                    }
                    finalQuery = wordDisMaxQuery;

                    // 添加年份调整的 function_score 查询
                    finalQuery = adjustScoreByFbdate(finalQuery);

                    synonymGroupDisMax.add(finalQuery);
                }
            }

            // 根据操作类型添加查询到主查询中
            switch (opType) {
                case 1: // OR
                    endBool.should().add(synonymGroupDisMax);
                    break;
                case 2: // AND
                    endBool.must().add(synonymGroupDisMax);
                    break;
                case 3: // NOT
                    endBool.mustNot().add(synonymGroupDisMax);
                    break;
                default:
                    throw new IllegalArgumentException("不支持的操作类型: " + opType);
            }

            return endBool;
        } catch (Exception e) {
            log.error("构建查询失败: {}", e.getMessage(), e);
            throw new RuntimeException("检索式格式错误: " + e.getMessage());
        }
    }

    private static QueryBuilder adjustScoreByFbdate(QueryBuilder baseQuery) {
        LocalDate currentDate = LocalDate.now();
        int currentYear = currentDate.getYear();

        // 创建 Script 对象
        Script script = new Script(ScriptType.INLINE, "painless",
                "if (params.doc['fbdate'].size() > 0) {" +
                        "    def fbdate = params.doc['fbdate'].value;" +
                        "    if (fbdate =~ /\\d{4}-\\d{2}-\\d{2}/) {" +
                        "        def fbdateParsed = LocalDate.parse(fbdate, DateTimeFormatter.ofPattern('yyyy-MM-dd'));" +
                        "        def yearsAgo = params.currentYear - fbdateParsed.getYear();" +
                        "        if (yearsAgo < 5) { return params.weight1; }" +
                        "        else if (yearsAgo < 10) { return params.weight2; }" +
                        "        else if (yearsAgo < 15) { return params.weight3; }" +
                        "    }" +
                        "}" +
                        "return 0.1;", // 默认权重为 0.1
                createScriptParams(currentYear)
        );

        // 创建 ScriptScoreFunctionBuilder
        ScriptScoreFunctionBuilder scriptScoreFunction = new ScriptScoreFunctionBuilder(script);

        // 创建 FunctionScoreQueryBuilder 并添加 ScriptScoreFunctionBuilder
        return QueryBuilders.functionScoreQuery(
                baseQuery,
                scriptScoreFunction
        );
    }

    private static Map<String, Object> createScriptParams(int currentYear) {
        Map<String, Object> params = new HashMap<>();
        params.put("currentYear", currentYear);
        params.put("weight1", 2.0);
        params.put("weight2", 0.7);
        params.put("weight3", 0.3);
        return params;
    }

    /**
     * 拼接临床试验检索条件
     * @param words 检索词
     * @param status true，A OR B OR C OR ...
     * @param opType 1-OR；2-AND；3-NOT
     * @return 单次拼接后的query
     */
    private static QueryBuilder buildClinicalTrialsQueryBuilder(String range, String words, boolean status, int opType){
        List<String> retrieval = new ArrayList<>();
        if (status){
            //相同操作符拼接的检索条件
            String[] split = words.split("\\|");
            retrieval.addAll(Arrays.asList(split));
        }else {
            retrieval.add(words);
        }
        try {
            BoolQueryBuilder endBool = QueryBuilders.boolQuery();
            for (String cond : retrieval) {
                cond = cond.toLowerCase();
                BoolQueryBuilder ans = QueryBuilders.boolQuery();
                MultiMatchQueryBuilder condition = null;
                QueryBuilder rangeCondition = null;
                if (StringUtils.isNotBlank(range)){
                    if (StrUtil.equals("适应症", range)) {
                        condition = QueryBuilders.multiMatchQuery(cond, "condition");
                    } else if (StrUtil.equals("干预措施", range)) {
                        condition = QueryBuilders.multiMatchQuery(cond, "intervention");
                    } else if (StrUtil.equals("分类", range)) {
                        ans.should().add(QueryBuilders.termQuery("belong", cond));
                    } else if (StrUtil.equals("注册号", range)) {
                        ans.should().add(QueryBuilders.termQuery("registerNo", cond));
                    } else if (StrUtil.equals("研究类型", range)) {
                        ans.should().add(QueryBuilders.termQuery("studyType", cond));
                    } else if (StrUtil.equals("试验题目", range)) {
                        MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("publicTitle", cond);
                        matchQueryBuilder.operator(Operator.AND);
                        ans.should().add(matchQueryBuilder);
                    } else if (StrUtil.equals("全部", range)) {
                        condition = QueryBuilders.multiMatchQuery(cond, "condition", "intervention");
                        MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("publicTitle", cond);
                        matchQueryBuilder.operator(Operator.AND);
                        ans.should().add(matchQueryBuilder);
                        TermQueryBuilder registerNo = QueryBuilders.termQuery("registerNo", cond.toLowerCase());
                        ans.should().add(registerNo);
                    } else if (StrUtil.equals("注册时间", range)) {
                        String[] timeRange = cond.split("[:：]");
                        rangeCondition = QueryBuilders.rangeQuery("registerDate").gte(timeRange[0].trim()).lte(timeRange[1].trim());
                    }
                }else {
                    condition = QueryBuilders.multiMatchQuery(cond, "condition", "intervention");
                    condition.operator(Operator.AND);
                    //condition.type(MultiMatchQueryBuilder.Type.PHRASE);
                    ans.should().add(condition);
                    MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("publicTitle", cond);
                    matchQueryBuilder.operator(Operator.AND);
                    ans.should().add(matchQueryBuilder);
                    TermQueryBuilder registerNo = QueryBuilders.termQuery("registerNo", cond.toLowerCase());
                    ans.should().add(registerNo);
                }
                if (condition != null) {
                    condition.operator(Operator.AND);
                    condition.type(MultiMatchQueryBuilder.Type.PHRASE);
                    ans.should().add(condition);
                } else if (rangeCondition != null) {
                    ans.should().add(rangeCondition);
                }
                if (opType == 1){
                    //OR
                    endBool.should().add(ans);
                }else if (opType == 2){
                    //AND
                    endBool.must().add(ans);
                }else {
                    //NOT
                    return ans;
                }
            }
            return endBool;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
            throw new RuntimeException("检索式格式错误");
        }
    }






    /**
     * 双氯芬酸[标题]
     * 获取检索式单元中的实际检索词
     * @param ops 检索单元
     * @param range 检索范围
     * @return 实际检索词
     */
    public static String getWords(String ops, String range) {
        return ops.replaceAll("\\[" + range + "]", "");
    }

    /**
     * 双氯芬酸[标题]
     * 获取检索式单元中的检索范围
     * @param ops 检索单元
     * @return 检索范围
     */
    public static String getRange(String ops) {
        if (ops.endsWith("]")) {
            Integer start = null;
            for (int i = ops.length() - 2; i >= 0; i--) {
                if (ops.charAt(i) == '[') {
                    start = i + 1;
                    break;
                }
            }
            if (start == null) {
                throw new RuntimeException("检索式格式错误");
            }
            return ops.substring(start, ops.length() - 1);
        }
        return null;
    }

    /**
     * 获取一个单词的所有形变
     * @param words 单词或一系列单词
     * @return 所有形变的集合
     */
    public static List<String> getAllDeformation(String words) {
        Set<String> result = new HashSet<>();
        String[] split = words.split("\\|");
        for (String word : split) {
            boolean aBoolean = judgeChinese(word);
            if (!aBoolean) {
                if (!word.contains(" ")) {
                    词条 entry = 英汉词典.查词(word);
                    if (entry != null) {
                        List<词形变化> deformation = entry.变形;
                        for (词形变化 inflection : deformation) {
                            String form = inflection.词形;
                            if (form.length() > 1) {
                                result.add(form);
                            }
                        }
                    }
                }
            }
            result.add(word);
        }
        return new ArrayList<>(result);
    }

    /**
     * 拼接文献检索条件
     * @param range 检索范围
     * @param word 检索词
     * @return 单次拼接后的query
     */
    private static BoolQueryBuilder buildPaperWildCardQueryBuilder(String range, String word, Integer isPhrase) {
        List<String> rangName = new ArrayList<>();
        if (StrUtil.isNotEmpty(range)) {
            if (StrUtil.equals("标题", range) || StrUtil.equals("主题", range)) {
                rangName.add("title");
            } else if (StrUtil.equals("摘要", range)) {
                rangName.add("summary");
            } else if (StrUtil.equals("关键词", range)) {
                rangName.add("allKeyword");
            } else if (StrUtil.equals("题关摘", range)) {
                rangName.addAll(Arrays.asList("title", "summary", "allKeyword"));
            } else if (StrUtil.equals("作者", range)) {
                rangName.add("author");
            } else if (StrUtil.equals("全部", range)) {
                rangName.addAll(Arrays.asList("title", "summary", "allKeyword", "journal"));
            } else if (StrUtil.equals("期刊", range)) {
                rangName.add("journal");
            } else if (StrUtil.equals("机构", range)) {
                rangName.add("showAuthorAddress");
            }else if(StrUtil.equals("精筛", range)){
                rangName.addAll(Arrays.asList("title", "titleQuestion", "tldr", "result", "conclusion", "allKeyword"));
            }else if(StrUtil.equals("初筛", range)){
                rangName.addAll(Arrays.asList("title", "titleQuestion", "tldr", "summary", "result", "conclusion", "author", "journal", "allKeyword"));
            }
        } else {
            rangName.addAll(Arrays.asList("title", "summary", "tldr", "result", "conclusion", "allKeyword"));
        }
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        BoolQueryBuilder wildBool = QueryBuilders.boolQuery();
        String[] split = word.split(" ");
        for (String rangeType : rangName) {
            if (word.contains(" ")) {
                for (String s1 : split) {
                    if (s1.contains("*")) {
                        if (!"*".equals(s1)) {
                            wildBool.should().add(QueryBuilders.wildcardQuery(rangeType, s1));
                        }
                    }
                }
            }
        }
        boolQueryBuilder.must().add(wildBool);
        for (String s1 : split) {
            if (!s1.contains("*")) {
                boolQueryBuilder.must().add(buildPaperQueryBuilder(range, s1, false, 2, isPhrase, 0));
            }
        }
        return boolQueryBuilder;
    }

    /**
     * 拼接说明书检索条件
     * @param words 检索词
     * @param status true，A OR B OR C OR ...
     * @param opType 1-OR；2-AND；3-NOT
     * @return 单次拼接后的query
     */
    private static QueryBuilder buildInstructionQueryBuilder(String range, String words, boolean status, int opType){
        List<String> retrieval = new ArrayList<>();
        if (status){
            //相同操作符拼接的检索条件
            String[] split = words.split("\\|");
            retrieval.addAll(Arrays.asList(split));
        }else {
            retrieval.add(words);
        }
        try {
            BoolQueryBuilder endBool = QueryBuilders.boolQuery();
            for (String cond : retrieval) {
                BoolQueryBuilder outAns = QueryBuilders.boolQuery();
                String word = cond.toLowerCase();
                word = MedicalTermFilter.filterSemanticWords(word);
                BoolQueryBuilder ans = QueryBuilders.boolQuery();
                MultiMatchQueryBuilder condition = null;
                QueryBuilder rangeCondition = null;
                if (StringUtils.isNotBlank(range)) {
                    if (StrUtil.equals("说明书名称", range)) {
                        condition = QueryBuilders.multiMatchQuery(word, "simpleGenericNames", "simpleEnglishName");
                    } else if (StrUtil.equals("商品名称", range)) {
                        condition = QueryBuilders.multiMatchQuery(word, "simpleTradeNames");
                    } else if (StrUtil.equals("来源", range)) {
                        ans.should().add(QueryBuilders.termQuery("source", word));
                    } else if (StrUtil.equals("适应症", range)) {
                        MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("indication", word);
                        matchQueryBuilder.operator(Operator.AND);
                        ans.should().add(matchQueryBuilder);
                    } else if (StrUtil.equals("全部", range)) {
                        condition = QueryBuilders.multiMatchQuery(word, "simpleGenericNames", "simpleEnglishName", "simpleTradeNames");
                        //ans.should().add(QueryBuilders.matchQuery("indication", cond));
                        ans.should().add(QueryBuilders.termQuery("source", word));
                        condition.field("simpleGenericNames", 100f);
                    } else if (StrUtil.equals("年份", range)) {
                        String[] timeRange = word.split("[:：]");
                        rangeCondition = QueryBuilders.rangeQuery("revisionDate").gte(timeRange[0].trim()).lte(timeRange[1].trim());
                    } else if (StrUtil.equals("二次检索", range)) {
                        condition = QueryBuilders.multiMatchQuery(word, "simpleGenericNames", "simpleEnglishName", "simpleTradeNames", "indication", "enterpriseName");
                    } else if (StrUtil.equals("非药品", range)) {
                        condition = QueryBuilders.multiMatchQuery(word, "simpleGenericNames", "simpleEnglishName", "simpleTradeNames");
                        MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("indication", word);
                        matchQueryBuilder.operator(Operator.AND);
                        ans.should().add(matchQueryBuilder);
                        ans.should().add(QueryBuilders.termQuery("source", word));
                        condition.field("simpleGenericNames", 100f);
                    } else if (StrUtil.equals("精准查询", range)) {
                        condition = QueryBuilders.multiMatchQuery(word, "simpleGenericNames", "simpleEnglishName");
                        condition.operator(Operator.AND);
                        condition.field("simpleGenericNames", 100f);
                        condition.field("simpleEnglishName", 0.1f);
                        condition.type(MultiMatchQueryBuilder.Type.PHRASE);
                        TermQueryBuilder termQuery = QueryBuilders.termQuery("simpleTradeNames.keyword", word.toLowerCase());
                        ans.should().add(termQuery);
                        ans.should().add(condition);
                    }
                } else {
                    condition = QueryBuilders.multiMatchQuery(word, "simpleGenericNames", "simpleEnglishName", "simpleTradeNames");
                    condition.operator(Operator.AND);
                    condition.field("simpleGenericNames", 100f);
                    condition.field("simpleEnglishName", 0.1f);
                    condition.type(MultiMatchQueryBuilder.Type.PHRASE);
                    ans.should().add(condition);
                }
                if (condition != null) {
                    condition.operator(Operator.AND);
                    condition.type(MultiMatchQueryBuilder.Type.PHRASE);
                    //condition.analyzer("standard");
                    ans.should().add(condition);
                } else if (rangeCondition != null) {
                    ans.should().add(rangeCondition);
                }
                outAns.should().add(ans);

                if (opType == 1){
                    //OR
                    endBool.should().add(outAns);
                }else if (opType == 2){
                    //AND
                    endBool.must().add(outAns);
                }else {
                    //NOT
                    return outAns;
                }
            }
            return endBool;
        } catch (Exception e) {
            log.error(e.getMessage(), e);
            throw new RuntimeException("检索式格式错误");
        }
    }

    
}
