package com.sentum.drugsafe.utils;

import com.lowagie.text.Cell;
import com.lowagie.text.Table;
import org.apache.commons.lang.StringUtils;
import org.apache.poi.xwpf.usermodel.*;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;

import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;

import static org.jsoup.nodes.Document.OutputSettings.Syntax.html;

/**
 * 处理用户输入的检索条件的工具类
 *
 * @author zgm
 */
public class AnalyzeConditionUtils {


    /**
     * 拆分一般括号的值
     *
     * @param formulaStr
     * @return （）中的内容以list返回
     */
    public static List<String> parenthesisFormat(String formulaStr) {
        ArrayList<String> strings = new ArrayList<>();
        formulaStr = formulaStr.replaceAll("（", "(");
        formulaStr = formulaStr.replaceAll("）", ")");
        formulaStr = formulaStr.replace((char) 12288, ' '); // 替换全角空格为半角空格

        LinkedList<Character> stack = new LinkedList<>();
        StringBuilder currentSubstring = new StringBuilder();
        boolean insideParentheses = false; // 标记是否在括号内

        for (int i = 0; i < formulaStr.length(); i++) {
            char c = formulaStr.charAt(i);

            if (c == '(') {
                // 如果遇到左括号，重置当前子串构建器并标记在括号内
                if (currentSubstring.length() > 0) {
                    strings.add(currentSubstring.toString());
                    currentSubstring = new StringBuilder();
                }
                insideParentheses = true;
                stack.push(c);
            } else if (c == ')') {
                // 如果遇到右括号，从栈中弹出直到遇到左括号
                while (!stack.isEmpty() && stack.peek() != '(') {
                    char topChar = stack.pop();
                    currentSubstring.append(topChar);
                }
                // 弹出左括号
                if (!stack.isEmpty()) {
                    stack.pop();
                }
                insideParentheses = false; // 退出括号

                // 如果当前子串不为空，则添加到结果列表
                if (currentSubstring.length() > 0) {
                    strings.add(currentSubstring.toString());
                    currentSubstring = new StringBuilder();
                }
            } else if (insideParentheses) {
                // 对于非括号字符，如果当前在括号内，则添加到当前子串构建器中
                currentSubstring.append(c);
            }
        }
        // 如果字符串以括号结束，且括号内还有内容，则添加剩余内容到结果列表
        if (currentSubstring.length() > 0) {
            strings.add(currentSubstring.toString());
        }

        return strings;
    }


        /**
         * 拆分中括号的值
         *
         * @param formulaStr
         * @return []中的内容以list返回
         */
        public static List<String> bracketFormat (String formulaStr){
            ArrayList<String> strings = new ArrayList<>();
            formulaStr = formulaStr.replace((char) 12288, ' '); // 替换全角空格为半角空格

            LinkedList<Character> stack = new LinkedList<>();
            StringBuilder currentSubstring = new StringBuilder();
            boolean insideParentheses = false; // 标记是否在括号内

            for (int i = 0; i < formulaStr.length(); i++) {
                char c = formulaStr.charAt(i);

                if (c == '[') {
                    // 如果遇到左括号，重置当前子串构建器并标记在括号内
                    if (currentSubstring.length() > 0) {
                        strings.add(currentSubstring.toString());
                        currentSubstring = new StringBuilder();
                    }
                    insideParentheses = true;
                    stack.push(c);
                } else if (c == ']') {
                    // 如果遇到右括号，从栈中弹出直到遇到左括号
                    while (!stack.isEmpty() && stack.peek() != '[') {
                        char topChar = stack.pop();
                        currentSubstring.append(topChar);
                    }
                    // 弹出左括号
                    if (!stack.isEmpty()) {
                        stack.pop();
                    }
                    insideParentheses = false; // 退出括号

                    // 如果当前子串不为空，则添加到结果列表
                    if (currentSubstring.length() > 0) {
                        strings.add(currentSubstring.toString());
                        currentSubstring = new StringBuilder();
                    }
                } else if (insideParentheses) {
                    // 对于非括号字符，如果当前在括号内，则添加到当前子串构建器中
                    currentSubstring.append(c);
                }
            }

            // 如果字符串以括号结束，且括号内还有内容，则添加剩余内容到结果列表
            if (currentSubstring.length() > 0) {
                strings.add(currentSubstring.toString());
            }

            return strings;
        }

        public static Table  setTable(String html){
            try {
                // 使用Jsoup解析HTML
                Document doc = Jsoup.parse(html);
                Element table = doc.select("table").first();
                org.jsoup.select.Elements rows = table.select("tr");

                Elements cell = rows.get(0).select("td");
                //创建表格
                Table table1 = new Table(cell.size());
                // 填充Word表格
                for (int i = 0; i < rows.size(); i++) {
                    for (int j = 0; j < cell.size(); j++) {
                        Elements td = rows.get(i).select("td");
                        String text = td.text();
                        Cell Cell1 = new Cell(text);
                        table1.addCell(Cell1);

                    }
                }
                // 保存Word文档

                System.out.println("Word表格已成功创建！");

                return table1;
            } catch (Exception e) {
                e.printStackTrace();
            }
            return null;
        }


    /**
     * 拼接检索式
     * @param query
     * @param inner
     * @param type
     */
    public static void montageForPaper(StringBuilder query, List<String> inner, String type) {
        query.append("(");
        for (int i = 0; i < inner.size() - 1; i++) {
            //去除检索条件中的括号
            String s = inner.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            s = s.replaceAll("（", "").replaceAll("）", "");
            if (StringUtils.isNotBlank(type)) {
                query.append(s).append("[").append(type).append("]").append(" OR ");
            } else {
                query.append(s).append(" OR ");
            }
        }
        String s = inner.get(inner.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        s = s.replaceAll("（", "").replaceAll("）", "");
        if (StringUtils.isNotBlank(type)) {
            query.append(s).append("[").append(type).append("]");
        } else {
            query.append(s);
        }
        query.append(")");
    }



    }