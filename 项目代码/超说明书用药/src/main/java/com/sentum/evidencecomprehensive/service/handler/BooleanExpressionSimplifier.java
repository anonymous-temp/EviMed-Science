package com.sentum.evidencecomprehensive.service.handler;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description: 合并query 中的 符号
 * DateTime: 2025/7/22
 */
public class BooleanExpressionSimplifier {

    // 定义操作符优先级
    private static final Map<String, Integer> OPERATOR_PRIORITY = new HashMap<>();
    static {
        OPERATOR_PRIORITY.put("OR", 1);
        OPERATOR_PRIORITY.put("AND", 2);
        OPERATOR_PRIORITY.put("NOT", 2);
    }

    // 表达式节点
    static class ExprNode {
        String operator; // AND, OR, NOT, null(叶子节点)
        String value;    // 叶子节点的值
        List<ExprNode> children;

        ExprNode(String value) {
            this.value = value;
            this.children = new ArrayList<>();
        }

        ExprNode(String operator, List<ExprNode> children) {
            this.operator = operator;
            this.children = children;
        }

        boolean isLeaf() {
            return operator == null;
        }

        boolean isOr() {
            return "OR".equals(operator);
        }

        boolean isAnd() {
            return "AND".equals(operator);
        }

        @Override
        public String toString() {
            if (isLeaf()) {
                return value;
            } else {
                return operator + "[" + children.size() + "]";
            }
        }
    }

    public static void main(String[] args) {
        String input = "(azd2281 OR azd221olaparib OR olaparib OR azd 2281 OR 奥拉帕利 OR lynparza OR 奥拉帕尼 OR azd-2281) AND ((cancer, pancreas OR pancreatic neoplasms OR neoplasm, pancreas OR pancreatic acinar carcinomas OR neoplasms, pancreatic OR carcinomas, pancreatic acinar OR carcinoma, pancreatic acinar OR pancreatic neoplasm OR pancreatic cancer OR 胰腺癌症 OR cancer of the pancreas OR pancreas cancer OR pancreas cancers OR pancreatic cancers OR 胰腺肿瘤 OR carcinomas, pancreatic OR pancreas neoplasms OR cancer of pancreas OR cancers, pancreas OR pancreatic acinar carcinoma OR acinar carcinoma, pancreatic OR neoplasm, pancreatic OR cancers, pancreatic OR pancreatic carcinoma OR acinar carcinomas, pancreatic OR pancreatic carcinomas OR 胰腺癌 OR neoplasms, pancreas OR carcinoma, pancreatic OR cancer, pancreatic OR pancreas neoplasm) AND (brca gene mutation OR brca基因突变) OR (brca1/2 mutation OR {brca1/2突变}) OR (gene mutation OR 基因突变))";

        BooleanExpressionSimplifier simplifier = new BooleanExpressionSimplifier();
        String result = simplifier.simplify(input);
        System.out.println("Original: " + input);
        System.out.println("\nSimplified: " + result);
    }

    public String simplify(String expression) {
        try {
            // 1. 构建表达式树
            ExprNode root = parseExpression(expression);

            // 2. 简化表达式树
            ExprNode simplified = simplifyTree(root);

            // 3. 将表达式树转回字符串
            return treeToString(simplified, null);
        } catch (Exception e) {
            e.printStackTrace();
            return expression;
        }
    }

    // 解析表达式
    private ExprNode parseExpression(String expr) {
        expr = expr.trim();

        // 移除最外层的括号（如果整个表达式被括号包围）
        expr = removeOuterParentheses(expr);

        // 查找主操作符（优先级最低且不在括号内的）
        int mainOpIndex = findMainOperator(expr);

        if (mainOpIndex == -1) {
            // 没有操作符，是叶子节点
            return new ExprNode(expr);
        }

        // 获取操作符
        String operator = extractOperator(expr, mainOpIndex);

        if ("NOT".equals(operator)) {
            // NOT是一元操作符
            String remaining = expr.substring(mainOpIndex + 3).trim();
            ExprNode child = parseExpression(remaining);
            List<ExprNode> children = new ArrayList<>();
            children.add(child);
            return new ExprNode(operator, children);
        } else {
            // AND或OR是二元操作符，需要收集所有相同操作符的操作数
            List<String> parts = splitByOperator(expr, operator);
            List<ExprNode> children = new ArrayList<>();

            for (String part : parts) {
                children.add(parseExpression(part));
            }

            return new ExprNode(operator, children);
        }
    }

    // 移除最外层括号
    private String removeOuterParentheses(String expr) {
        if (expr.startsWith("(") && expr.endsWith(")")) {
            int depth = 0;
            boolean canRemove = true;

            for (int i = 0; i < expr.length(); i++) {
                char ch = expr.charAt(i);
                if (ch == '(') depth++;
                else if (ch == ')') depth--;

                // 如果在中间位置depth变为0，说明不是整体括号
                if (depth == 0 && i < expr.length() - 1) {
                    canRemove = false;
                    break;
                }
            }

            if (canRemove) {
                return expr.substring(1, expr.length() - 1).trim();
            }
        }
        return expr;
    }

    // 查找主操作符
    private int findMainOperator(String expr) {
        int depth = 0;
        int lowestPriority = Integer.MAX_VALUE;
        int mainOpIndex = -1;

        for (int i = 0; i < expr.length(); i++) {
            char ch = expr.charAt(i);

            if (ch == '(' || ch == '{') {
                depth++;
            } else if (ch == ')' || ch == '}') {
                depth--;
            } else if (depth == 0) {
                // 检查是否是操作符
                String op = extractOperator(expr, i);
                if (op != null) {
                    int priority = OPERATOR_PRIORITY.get(op);
                    if (priority <= lowestPriority) {
                        lowestPriority = priority;
                        mainOpIndex = i;
                    }
                    i += op.length() - 1; // 跳过操作符
                }
            }
        }

        return mainOpIndex;
    }

    // 提取操作符
    private String extractOperator(String expr, int index) {
        for (String op : new String[]{"AND", "OR", "NOT"}) {
            if (index + op.length() <= expr.length()) {
                String candidate = expr.substring(index, index + op.length());
                if (candidate.equals(op)) {
                    // 检查前后是否是边界
                    boolean prevOk = index == 0 || !Character.isLetterOrDigit(expr.charAt(index - 1));
                    boolean nextOk = index + op.length() >= expr.length() ||
                            !Character.isLetterOrDigit(expr.charAt(index + op.length()));
                    if (prevOk && nextOk) {
                        return op;
                    }
                }
            }
        }
        return null;
    }

    // 按操作符分割表达式
    private List<String> splitByOperator(String expr, String operator) {
        List<String> parts = new ArrayList<>();
        int depth = 0;
        int lastSplit = 0;

        for (int i = 0; i < expr.length(); i++) {
            char ch = expr.charAt(i);

            if (ch == '(' || ch == '{') {
                depth++;
            } else if (ch == ')' || ch == '}') {
                depth--;
            } else if (depth == 0) {
                String op = extractOperator(expr, i);
                if (operator.equals(op)) {
                    parts.add(expr.substring(lastSplit, i).trim());
                    i += op.length() - 1;
                    lastSplit = i + 1;
                }
            }
        }

        if (lastSplit < expr.length()) {
            parts.add(expr.substring(lastSplit).trim());
        }

        return parts;
    }

    // 简化表达式树
    private ExprNode simplifyTree(ExprNode node) {
        if (node == null || node.isLeaf()) {
            return node;
        }

        // 首先递归简化所有子节点
        List<ExprNode> simplifiedChildren = new ArrayList<>();
        for (ExprNode child : node.children) {
            ExprNode simplified = simplifyTree(child);
            simplifiedChildren.add(simplified);
        }

        // 如果是OR操作符，合并同层的OR节点
        if (node.isOr()) {
            List<ExprNode> mergedChildren = new ArrayList<>();

            for (ExprNode child : simplifiedChildren) {
                if (child.isOr()) {
                    // 如果子节点也是OR，将其子节点提升
                    mergedChildren.addAll(child.children);
                } else {
                    mergedChildren.add(child);
                }
            }

            return new ExprNode("OR", mergedChildren);
        }

        // 如果是AND操作符，保持结构但使用简化后的子节点
        return new ExprNode(node.operator, simplifiedChildren);
    }

    // 将表达式树转换回字符串
    private String treeToString(ExprNode node, String parentOp) {
        if (node == null) return "";

        if (node.isLeaf()) {
            return node.value;
        }

        if ("NOT".equals(node.operator)) {
            String childStr = treeToString(node.children.get(0), node.operator);
            return "NOT " + childStr;
        }

        // AND 或 OR
        List<String> parts = new ArrayList<>();
        for (ExprNode child : node.children) {
            String childStr = treeToString(child, node.operator);
            parts.add(childStr);
        }

        String result = String.join(" " + node.operator + " ", parts);

        // 判断是否需要加括号
        if (parentOp != null && needsParentheses(parentOp, node.operator)) {
            result = "(" + result + ")";
        }

        return result;
    }

    private boolean needsParentheses(String parentOp, String childOp) {
        if (childOp == null) return false;
        int parentPriority = OPERATOR_PRIORITY.get(parentOp);
        int childPriority = OPERATOR_PRIORITY.get(childOp);
        return childPriority < parentPriority;
    }
}