package com.sentum.util;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.sentum.enums.MongoTableNameEnum;
import com.sentum.pojo.EvidenceCMesh;
import com.sentum.pojo.EvidenceMesh;
import com.sentum.pojo.SingleMesh;
import org.apache.commons.lang3.StringUtils;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;

import java.util.*;
import java.util.stream.Collectors;

/**
 * 同义词逻辑，对用户输入的词进行同义词查询
 * @author zgm
 */
public class GetSynonymUtil {

    public static List<String> getSynonymTrans(String word) {
        boolean isChineseWord = judgeChinese(word);

        String searchTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
        if (!isChineseWord) {
            searchTable =MongoTableNameEnum.EVIDENCE_MESH.getName();
        }
        List<EvidenceMesh> resultMesh = MongoUtil.mongo.find(new Query(Criteria.where("entryTerms").is(word.toLowerCase())), EvidenceMesh.class, searchTable);

        List<String> result = new ArrayList<>();
        if (CollUtil.isNotEmpty(resultMesh)) {
            resultMesh.stream()
                    .map(EvidenceMesh::getEntryTerms)
                    .collect(Collectors.toList())
                    .forEach(result::addAll);
        }
        return result;
    }

    public static List<String> getSynonym(List<String> Synonyms) {
        List<String> result = new ArrayList<>();
        for (String synonym : Synonyms) {
            boolean isChineseWord = judgeChinese(synonym);
            
            String searchTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
            if (!isChineseWord) {
                searchTable = MongoTableNameEnum.EVIDENCE_MESH.getName();
            }
            List<EvidenceMesh> resultMesh = MongoUtil.mongo.find(new Query(Criteria.where("entryTerms").is(synonym)), EvidenceMesh.class, searchTable);
            if (CollUtil.isNotEmpty(resultMesh)) {
                resultMesh.stream()
                        .map(EvidenceMesh::getEntryTerms)
                        .collect(Collectors.toList())
                        .forEach(result::addAll);
            }
        }
        return result;
    }
    
    public static boolean getSynonym(String word, List<String> originalSynonym, List<String> transSynonym,List<String> otherSynonym) {
        boolean isChineseWord = judgeChinese(word);
        // 是否使用了 evidence_mesh表中的翻译词
        boolean isUseTrans = false;
        List<EvidenceCMesh> resultMesh = new ArrayList<>();
        String searchTable = "";
        if (!isChineseWord) {
            searchTable = MongoTableNameEnum.EVIDENCE_MESH.getName();
            resultMesh = MongoUtil.mongo.find(new Query(Criteria.where("entryTerms").is(word)), EvidenceCMesh.class, searchTable);
        }else {
            searchTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
            resultMesh = MongoUtil.mongo.find(new Query(Criteria.where("entryTerms").is(word)), EvidenceCMesh.class, searchTable);
        }

        List<String> zhMesh = new ArrayList<String>();
        List<String> enMesh = new ArrayList<String>();
        
        if (CollUtil.isNotEmpty(resultMesh)) {
            if (!isChineseWord){
                resultMesh.stream()
                        .map(EvidenceCMesh::getEntryTerms)
                        .collect(Collectors.toList())
                        .forEach(originalSynonym::addAll);

            }else {
                resultMesh.stream()
                        .map(EvidenceCMesh::getZhEntryTerms)
                        .collect(Collectors.toList())
                        .forEach(originalSynonym::addAll);
                resultMesh.stream()
                        .map(EvidenceCMesh::getOtherEntryTerms)
                        .collect(Collectors.toList())
                        .forEach(otherSynonym::addAll);
            }

        }


        
        // 逻辑是 先根据原词的翻译词去找同义词  如果原词没有翻译词 再去火山翻译
        resultMesh.forEach((evidenceMesh) -> {
            if (StrUtil.isNotBlank(evidenceMesh.getNameZh())) {
                zhMesh.add(evidenceMesh.getNameZh().toLowerCase());
            }
            if (StrUtil.isNotBlank(evidenceMesh.getNameEn())) {
                enMesh.add(evidenceMesh.getNameEn().toLowerCase());
            }
        });
        
        if (CollUtil.isNotEmpty(zhMesh) || CollUtil.isNotEmpty(enMesh)) {
            if (isChineseWord) {
                searchTable = MongoTableNameEnum.EVIDENCE_MESH.getName();
                if (CollUtil.isNotEmpty(enMesh)) {
                    List<EvidenceMesh> entryTerms = MongoUtil.mongo.find(new Query(Criteria.where("entryTerms").in(enMesh)), EvidenceMesh.class, searchTable);
                    entryTerms.stream()
                            .map(EvidenceMesh::getEntryTerms)
                            .collect(Collectors.toList())
                            .forEach(transSynonym::addAll);
                }


            } else {
                searchTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
                if (CollUtil.isNotEmpty(zhMesh)) {
                    List<EvidenceCMesh> entryTerms = MongoUtil.mongo.find(new Query(Criteria.where("entryTerms").in(zhMesh)), EvidenceCMesh.class, searchTable);
                    entryTerms.stream()
                            .map(EvidenceCMesh::getEntryTerms)
                            .collect(Collectors.toList())
                            .forEach(transSynonym::addAll);
                }

                if (CollUtil.isNotEmpty(zhMesh)) {
                    List<EvidenceCMesh> entryTerms = MongoUtil.mongo.find(new Query(Criteria.where("entryTerms").in(zhMesh)), EvidenceCMesh.class, searchTable);
                    entryTerms.stream()
                            .map(EvidenceCMesh::getZhEntryTerms)
                            .collect(Collectors.toList())
                            .forEach(transSynonym::addAll);
                    entryTerms.stream()
                            .map(EvidenceCMesh::getOtherEntryTerms)
                            .collect(Collectors.toList())
                            .forEach(otherSynonym::addAll);
                }
            }
            isUseTrans = true;
        }
        return isUseTrans;
    }



    public static boolean getSynonym(String word, List<String> originalSynonym, List<String> transSynonym) {
        boolean isChineseWord = judgeChinese(word);
        // 是否使用了 evidence_mesh表中的翻译词
        boolean isUseTrans = false;
        List<EvidenceCMesh> resultMesh = new ArrayList<>();
        String searchTable = "";
        if (!isChineseWord) {
            searchTable = MongoTableNameEnum.EVIDENCE_MESH.getName();
            resultMesh = MongoUtil.mongo.find(new Query(Criteria.where("entryTerms").is(word)), EvidenceCMesh.class, searchTable);
        }else {
            searchTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
            resultMesh = MongoUtil.mongo.find(new Query(Criteria.where("entryTerms").is(word)), EvidenceCMesh.class, searchTable);
        }

        List<String> zhMesh = new ArrayList<String>();
        List<String> enMesh = new ArrayList<String>();

        if (CollUtil.isNotEmpty(resultMesh)) {
            if (!isChineseWord){
                resultMesh.stream()
                        .map(EvidenceCMesh::getEntryTerms)
                        .collect(Collectors.toList())
                        .forEach(originalSynonym::addAll);
            }else {
                resultMesh.stream()
                        .map(EvidenceCMesh::getZhEntryTerms)
                        .collect(Collectors.toList())
                        .forEach(originalSynonym::addAll);
            }

        }



        // 逻辑是 先根据原词的翻译词去找同义词  如果原词没有翻译词 再去火山翻译
        resultMesh.forEach((evidenceMesh) -> {
            if (StrUtil.isNotBlank(evidenceMesh.getNameZh())) {
                zhMesh.add(evidenceMesh.getNameZh().toLowerCase());
            }
            if (StrUtil.isNotBlank(evidenceMesh.getNameEn())) {
                enMesh.add(evidenceMesh.getNameEn().toLowerCase());
            }
        });

        if (CollUtil.isNotEmpty(zhMesh) || CollUtil.isNotEmpty(enMesh)) {
            if (isChineseWord) {
                searchTable = MongoTableNameEnum.EVIDENCE_MESH.getName();
                if (CollUtil.isNotEmpty(enMesh)) {
                    List<EvidenceMesh> entryTerms = MongoUtil.mongo.find(new Query(Criteria.where("entryTerms").in(enMesh)), EvidenceMesh.class, searchTable);
                    entryTerms.stream()
                            .map(EvidenceMesh::getEntryTerms)
                            .collect(Collectors.toList())
                            .forEach(transSynonym::addAll);
                }


            } else {
                searchTable = MongoTableNameEnum.EVIDENCE_C_MESH.getName();
                if (CollUtil.isNotEmpty(zhMesh)) {
                    List<EvidenceCMesh> entryTerms = MongoUtil.mongo.find(new Query(Criteria.where("entryTerms").in(zhMesh)), EvidenceCMesh.class, searchTable);
                    entryTerms.stream()
                            .map(EvidenceCMesh::getEntryTerms)
                            .collect(Collectors.toList())
                            .forEach(transSynonym::addAll);
                }

                if (CollUtil.isNotEmpty(zhMesh)) {
                    List<EvidenceCMesh> entryTerms = MongoUtil.mongo.find(new Query(Criteria.where("entryTerms").in(zhMesh)), EvidenceCMesh.class, searchTable);
                    entryTerms.stream()
                            .map(EvidenceCMesh::getZhEntryTerms)
                            .collect(Collectors.toList())
                            .forEach(transSynonym::addAll);

                }
            }
            isUseTrans = true;
        }
        return isUseTrans;
    }

    /**
     * 查询当前词的全部同义词
     * @param word 需要查询同义词的词
     * @return 同义词的集合
     */
    public static List<String> onlyGetSynonym(String word){
        List<String> result = new ArrayList<>();
        //去除左右空格
        word = word.trim();
        word = word.toLowerCase();
        //如果输入的词全部有数字组成，原样返回并提示暂无同义词
        char[] chars = word.toCharArray();
        boolean flag = false;
        for (char aChar : chars) {
            if (aChar < '0' || aChar > '9') {
                flag = true;
                break;
            }
        }
        if (!flag){
            return result;
        }
        Set<String> set = new HashSet<>();
        boolean b = judgeChinese(word);
        String tableName;
        if (b){
            //用户输入的词为中文
            tableName = "single_chinese_mesh";

        }else {
            //用户输入的词为英文
            tableName = "single_english_mesh";
        }
        List<SingleMesh> entryWord = MongoUtil.mongo.find(new Query(Criteria.where("lowerEntryWord").is(word)), SingleMesh.class, tableName);
        if (!entryWord.isEmpty()){
            //检索到同义词--保存该同义词并查找下一节点
            List<String> ids = new ArrayList<>();
            for (SingleMesh singleMesh : entryWord) {
                if (singleMesh.getEntryWord() != null){
                    set.addAll(singleMesh.getEntryWord());
                }
                if (singleMesh.getIds() != null){
                    ids.addAll(singleMesh.getIds());
                }
            }
            findMeshById(ids, set, tableName);
        }
        //将set存放到list中
        if (set.size() > 0){
            result.addAll(set);
        }
        return result;
    }

    /**
     * 查询第一个节点的同义词
     * @param word 需要确定同义词的词
     * @return 当前词的同义词
     */
    public static List<String> getFirstSynonym(String word){
        List<String> result = new ArrayList<>();
        //去除左右空格
        word = word.trim();
        word = word.toLowerCase();
        Set<String> set = new HashSet<>();
        boolean b = judgeChinese(word);
        String tableName;
        if (b){
            //用户输入的词为中文
            tableName = "single_chinese_mesh";

        }else {
            //用户输入的词为英文
            tableName = "single_english_mesh";
        }
        List<SingleMesh> entryWord = MongoUtil.mongo.find(new Query(Criteria.where("lowerEntryWord").is(word)), SingleMesh.class, tableName);
        //正则保留不区分大小写进行匹配-23号后
        if (!entryWord.isEmpty()){
            //检索到同义词--保存该同义词并查找下一节点
            for (SingleMesh singleMesh : entryWord) {
                if (singleMesh.getEntryWord() != null){
                    set.addAll(singleMesh.getEntryWord());
                }
            }
        }
        //将set存放到list中
        if (set.size() > 0){
            result.addAll(set);
        }else {
            result.add(word);
        }
        return result;
    }

    //同义词过多时，只取一部分
    public static List<String> getMoreSynonym(String word){
        List<String> result = new ArrayList<>();
        //去除左右空格
        word = word.trim();
        word = word.toLowerCase();
        Set<String> set = new HashSet<>();
        boolean b = judgeChinese(word);
        String tableName;
        if (b){
            //用户输入的词为中文
            tableName = "single_chinese_mesh";

        }else {
            //用户输入的词为英文
            tableName = "single_english_mesh";
        }
        List<SingleMesh> entryWord = MongoUtil.mongo.find(new Query(Criteria.where("lowerEntryWord").is(word)), SingleMesh.class, tableName);
        //正则保留不区分大小写进行匹配-23号后
        if (!entryWord.isEmpty()){
            //检索到同义词--保存该同义词并查找下一节点
            List<String> ids = new ArrayList<>();
            for (SingleMesh singleMesh : entryWord) {
                if (singleMesh.getEntryWord() != null){
                    set.addAll(singleMesh.getEntryWord());
                }
                //下一节点
                if (singleMesh.getIds() != null && singleMesh.getIds().size() > 0){
                    ids.addAll(singleMesh.getIds());
                }
            }
            findMeshById(ids, set, tableName);
            if (set.size() > 100){
                List<String> list = new ArrayList<>(set);
                if (list.size() > 64){
                    //取最短的64个词语
                    Map<String, String> shortMap = new HashMap<>();
                    for (String scalingDownSynonym : list) {
                        shortMap.put(scalingDownSynonym.length() + scalingDownSynonym, scalingDownSynonym);
                    }
                    List<String> shortList = new ArrayList<>();
                    int i = 0;
                    Set<String> keySet = shortMap.keySet();
                    for (String s : keySet) {
                        if (i > 64){
                            break;
                        }
                        i++;
                        shortList.add(shortMap.get(s));
                    }
                    list = shortList;
                }
                list.add(word);
                result.addAll(list);
                return result;
            }
        }
        //将set存放到list中
        if (set.size() > 0){
            result.addAll(set);
        }
        return result;
    }

    /**
     * 用户输入的为标准词，匹配该标准词节点之后所有节点及其所有的同义词
     * @param ids 唯一的id的集合
     * @param set 存放中文同义词
     * @param tableName 需要查询的表名
     */
    public static void findMeshById(List<String> ids, Set<String> set, String tableName){
        if (CollUtil.isNotEmpty(ids)){
            List<String> newIds = new ArrayList<>();
            for (String id : ids) {
                if (StringUtils.isNotBlank(id)){
                    newIds.add(id);
                }
            }
            ids = newIds;
        }
        if (CollUtil.isNotEmpty(ids)) {
            StringBuilder builder = new StringBuilder();
            builder.append("^").append("(");
            for (int i = 0; i < ids.size() - 1; i++) {
                if (StringUtils.isNotBlank(ids.get(i))){
                    builder.append(ids.get(i)).append("|");
                }
            }
            if (StringUtils.isNotBlank(ids.get(ids.size() - 1))){
                builder.append(ids.get(ids.size() - 1));
            }
            builder.append(")");
            //检索树形
            String s = builder.toString();
            if (!"^()".equals(s)) {
                Query query = new Query(Criteria.where("ids").regex(s));
                List<SingleMesh> singleMeshes = MongoUtil.mongo.find(query, SingleMesh.class, tableName);
                for (SingleMesh singleMesh : singleMeshes) {
                    if (singleMesh.getEntryWord() != null) {
                        set.addAll(singleMesh.getEntryWord());
                    }
                }
            }
        }
    }

    /**
     * 通过查找同义词最小单元的方法缩减同义词数量提高检索效率
     * @param synonyms 同义词的集合
     */
    public static List<String> scalingDownSynonyms(List<String> synonyms){
        Set<String> onlySet = new HashSet<>(synonyms);
        synonyms = new ArrayList<>(onlySet);
        List<String> synonymsList = new ArrayList<>(onlySet);
        for (int i = 0; i < synonyms.size(); i++) {
            String s = synonyms.get(i).toLowerCase();
            for (int i1 = 0; i1 < synonyms.size(); i1++) {
                if (i1 != i) {
                    String s1 = synonyms.get(i1).toLowerCase();
                    boolean b = judgeChinese(s1);
                    if (b) {
                        //中文
                        if (s1.contains(s)) {
                            synonymsList.remove(s1);
                        }
                    }else {
                        //英文
                        if (s1.toLowerCase().contains(s + " ") || s1.toLowerCase().contains(" " + s)) {
                            synonymsList.remove(s1);
                        }
                    }
                }
            }
        }
        return synonymsList;
    }

    /**
     * 判断输入的词是中文还是英文
     * @param str 需要判断的词
     * @return 中文为true，英文为false
     */
    public static boolean judgeChinese(String str){
        return str.getBytes().length != str.length();
    }

    
}
